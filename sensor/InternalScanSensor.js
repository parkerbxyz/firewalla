/*    Copyright 2020-2021 Firewalla Inc.
 *
 *    This program is free software: you can redistribute it and/or  modify
 *    it under the terms of the GNU Affero General Public License, version 3,
 *    as published by the Free Software Foundation.
 *
 *    This program is distributed in the hope that it will be useful,
 *    but WITHOUT ANY WARRANTY; without even the implied warranty of
 *    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *    GNU Affero General Public License for more details.
 *
 *    You should have received a copy of the GNU Affero General Public License
 *    along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */
'use strict';

const log = require('../net2/logger.js')(__filename);
const Sensor = require('./Sensor.js').Sensor;
const platformLoader = require('../platform/PlatformLoader.js');
const platform = platformLoader.getPlatform();
const firewalla = require('../net2/Firewalla.js');
const fs = require('fs');
const fsp = require('fs').promises;
const util = require('util');
const bone = require("../lib/Bone.js");
const rclient = require('../util/redis_manager.js').getRedisClient();
const cp = require('child_process');
const execAsync = util.promisify(cp.exec);
const scanDictPath = `${firewalla.getHiddenFolder()}/run/scan_dict`;
const HostManager = require("../net2/HostManager.js");
const hostManager = new HostManager();
const IdentityManager = require('../net2/IdentityManager.js');
const xml2jsonBinary = firewalla.getFirewallaHome() + "/extension/xml2json/xml2json." + firewalla.getPlatform();
const _ = require('lodash');
const bruteConfig = require('../extension/nmap/bruteConfig.json');
const AsyncLock = require('../vendor_lib/async-lock');
const lock = new AsyncLock();
const LOCK_TASK_QUEUE = "LOCK_TASK_QUEUE";
const MAX_CONCURRENT_TASKS = 3;
const sem = require('../sensor/SensorEventManager.js').getInstance();
const moment = require('moment-timezone/moment-timezone.js');
moment.tz.load(require('../vendor_lib/moment-tz-data.json'));

const extensionManager = require('./ExtensionManager.js');
const sysManager = require('../net2/SysManager.js');
const Constants = require('../net2/Constants.js');
const {Address4, Address6} = require('ip-address');

const STATE_SCANNING = "scanning";
const STATE_COMPLETE = "complete";
const STATE_STOPPED = "stopped";
const STATE_QUEUED = "queued";


class InternalScanSensor extends Sensor {
  async apiRun() {
    this.running = false;
    this.supportPorts = ["tcp_23", "tcp_80", "tcp_21", "tcp_3306", "tcp_6379"]; // default support: telnet http ftp mysql redis

    this.scheduledScanTasks = {};
    this.subTaskRunning = {};
    this.subTaskWaitingQueue = [];
    this.subTaskMap = {};
    const previousScanResult = await this.getScanResult();
    if (_.has(previousScanResult, "tasks"))
      this.scheduledScanTasks = previousScanResult.tasks;
    // set state of previous pending/running tasks to "stopped" on service restart
    for (const key of Object.keys(this.scheduledScanTasks)) {
      const task = this.scheduledScanTasks[key];
      if (task.state === STATE_QUEUED || task.state === STATE_SCANNING) {
        task.state = STATE_STOPPED;
        task.ets = Date.now() / 1000;
      }
    }
    await this.saveScanTasks();

    await execAsync(`sudo cp ../extension/nmap/scripts/mysql.lua /usr/share/nmap/nselib/`).catch((err) => {});

    if (platform.supportSSHInNmap()) {
      this.supportPorts.push("tcp_22");
    }

    setInterval(() => {
      this.checkDictionary().catch((err) => {
        log.error(`Failed to fetch dictionary from cloud`, err.message);
      });
    }, 3600 * 1000);
    await this.checkDictionary().catch((err) => {
      log.error(`Failed to fetch dictionary from cloud`, err.message);
    });

    extensionManager.onCmd("scheduleWeakPasswordScanTask", async (msg, data) => {
      const {type, target} = data;
      let key = null;
      let hosts = null;
      switch (type) {
        case "host": {
          key = target
          if (target === "0.0.0.0") {
            // for now, only VPN devices use identities, so it's okay to consider identities identical to VPN devices
            hosts = data.includeVPNNetworks ? hostManager.getActiveMACs().concat(IdentityManager.getAllIdentitiesGUID()) : hostManager.getActiveMACs();
          } else {
            hosts = [target];
          }
          break;
        }
        case "intf": {
          key = `intf:${target}`;
          const intfObj = sysManager.getInterfaceViaUUID(target);
          if (!intfObj)
            throw new Error(`Interface uuid ${target} is not found`);
          hosts = hostManager.getIntfMacs(target).concat(Object.entries(IdentityManager.getIdentitiesByNicName(intfObj.name)).flatMap(entry => Object.keys(entry[1]).map(uid => `${entry[0]}:${uid}`)));
          break;
        }
        case "tag": {
          key = `tag:${target}`;
          hosts = await hostManager.getTagMacs(target);
          break;
        }
        default:
          throw new Error(`Unrecognized type/target`);
      }
      hosts = hosts.filter(mac => !sysManager.isMyMac(mac));
      await this.submitTask(key, hosts);
      this.scheduleTask();
      await this.saveScanTasks();
      return this.getScanResult();
    });

    extensionManager.onGet("weakPasswordScanTasks", async (msg, data) => {
      return this.getScanResult();
    });

    extensionManager.onCmd("stopWeakPasswordScanTask", async (msg, data) => {
      const {type, target} = data;
      let key = null;
      switch (type) {
        case "host": {
          key = target
          break;
        }
        case "intf": {
          key = `intf:${target}`;
          break;
        }
        case "tag": {
          key = `tag:${target}`;
          break;
        }
        default:
          throw new Error(`Unrecognized type/target`);
      }
      if (!this.scheduledScanTasks[key])
        throw new Error(`Task on ${target} is not scheduled`);
      await lock.acquire(LOCK_TASK_QUEUE, async () => {
        const task = this.scheduledScanTasks[key];
        if (task.state === STATE_QUEUED || task.state === STATE_SCANNING) {
          task.state = STATE_STOPPED;
          task.ets = Date.now() / 1000;
        }
        for (const hostId of Object.keys(task.pendingHosts)) {
          const subTask = this.subTaskMap[hostId];
          delete subTask.subscribers[key];
          if (_.isEmpty(subTask.subscribers)) {
            delete this.subTaskMap[hostId];
            delete this.subTaskRunning[hostId];
            if (subTask.pid)
              await this.killTask(subTask.pid);
            this.subTaskWaitingQueue = this.subTaskWaitingQueue.filter(h => h !== hostId);
          }
        }
      });
      await this.saveScanTasks();
      return this.getScanResult();
    });

  }

  async killTask(pid) {
    const children = await execAsync(`pgrep -P ${pid}`).then((result) => result.stdout.trim().split("\n")).catch((err) => null);
    if (!_.isEmpty(children)) {
      for (const child of children)
        await this.killTask(child);
    }
    await execAsync(`sudo kill -SIGINT ${pid}`).catch((err) => {
      log.error(`Failed to kill task pid ${pid}`);
    });
  }

  async submitTask(key, hosts) {
    await lock.acquire(LOCK_TASK_QUEUE, async () => {
      if (_.has(this.scheduledScanTasks, key) && (this.scheduledScanTasks[key].state === STATE_QUEUED || this.scheduledScanTasks[key].state === STATE_SCANNING))
        return;
      const task = {state: STATE_QUEUED, ts: Date.now() / 1000};
      this.scheduledScanTasks[key] = task;
      task.pendingHosts = {};
      for (const host of hosts)
        task.pendingHosts[host] = 1;
      task.results = [];
      if (_.isEmpty(task.pendingHosts)) {
        task.state = STATE_COMPLETE;
        task.ets = Date.now() / 1000;
        return;
      }
      for (const host of hosts) {
        if (_.has(this.subTaskRunning, host) || this.subTaskWaitingQueue.includes(host))
          continue;
        this.subTaskWaitingQueue.push(host);
        if (!_.has(this.subTaskMap, host))
          this.subTaskMap[host] = {subscribers: {}};
        this.subTaskMap[host].subscribers[key] = 1;
      }
    }).catch((err) => {
      log.error(`Failed to submit task on ${key} with hosts ${hosts}`, err.message);
    });
  }

  async scheduleTask() {
    await lock.acquire(LOCK_TASK_QUEUE, async () => {
      while (Object.keys(this.subTaskRunning).length < MAX_CONCURRENT_TASKS && !_.isEmpty(this.subTaskWaitingQueue)) {
        const hostId = this.subTaskWaitingQueue.shift();
        this.subTaskRunning[hostId] = 1;
        const subTask = this.subTaskMap[hostId];
        if (subTask) {
          const subscribers = subTask.subscribers;
          for (const key of Object.keys(subscribers)) {
            const task = this.scheduledScanTasks[key];
            if (task)
              task.state = STATE_SCANNING;
          }
        }
        this.scanHost(hostId).catch((err) => {
          log.error(`Failed to scan host ${hostId}`, err.message);
        }).finally(() => this.scheduleTask());
      }
    });
  }

  async scanHost(hostId) {
    const weakPasswords = [];
    const ips = [];
    if (IdentityManager.isGUID(hostId)) {
      Array.prototype.push.apply(ips, IdentityManager.getIPsByGUID(hostId).filter((ip) => {
        // do not scan IP range on identities, e.g., peer allow IPs on wireguard peers
        let addr = new Address4(ip);
        if (addr.isValid()) {
          return addr.subnetMask === 32;
        } else {
          addr = new Address6(ip);
          if (addr.isValid())
            return addr.subnetMask === 128;
        }
        return false;
      }));
    } else {
      const host = hostManager.getHostFastByMAC(hostId);
      if (host && _.has(host, ["o", "ipv4Addr"]))
        ips.push(host.o.ipv4Addr);
    }
    const subTask = this.subTaskMap[hostId];
    for (const portId of this.supportPorts) {
      const config = bruteConfig[portId];
      const terminated = !_.has(this.subTaskMap, hostId);
      if (terminated) {
        log.info(`Host scan ${hostId} is terminated by stopWeakPasswordScanTask API`);
        break;
      }
      if (config && !terminated) {
        for (const ip of ips) {
          log.info(`Scan host ${hostId} ${ip} on port ${portId} ...`);
          const results = await this.nmapGuessPassword(ip, config, hostId);
          if (_.isArray(results)) {
            for (const r of results)
              weakPasswords.push(Object.assign({}, r, { protocol: config.protocol, port: config.port, serviceName: config.serviceName }));
          }
        }
      }
    }
    const result = Object.assign({}, { host: hostId, ts: Date.now() / 1000, result: weakPasswords });
    await this.saveToRedis(hostId, result);
    await this.setLastCompletedScanTs();
    await lock.acquire(LOCK_TASK_QUEUE, async () => {
      delete this.subTaskRunning[hostId];
      if (subTask) {
        const subscribers = subTask.subscribers;
        for (const key of Object.keys(subscribers)) {
          const task = this.scheduledScanTasks[key];
          if (task) {
            delete task.pendingHosts[hostId];
            task.results.push(result);
            if (_.isEmpty(task.pendingHosts)) {
              log.info(`All hosts on ${key} have been scanned, scan complete on ${key}`);
              const ets = Date.now() / 1000;
              await this.sendNotification(key, ets, task.results);
              task.state = STATE_COMPLETE;
              task.ets = ets;
              //delete this.scheduledScanTasks[key];
            }
          }
        }
      }
      await this.saveScanTasks();
      delete this.subTaskMap[hostId];
    });
  }

  async sendNotification(key, ets, results) {
    const numOfWeakPasswords = results.map(r => !_.isEmpty(r.result) ? r.result.length : 0).reduce((total, item) => total + item, 0);
    const timezone = sysManager.getTimezone();
    const time = (timezone ? moment.unix(ets).tz(timezone) : moment.unix(ets)).format("hh:mm A");
    sem.sendEventToFireApi({
      type: 'FW_NOTIFICATION',
      titleKey: 'NOTIF_WEAK_PASSWORD_SCAN_COMPLETE_TITLE',
      bodyKey: `NOTIF_WEAK_PASSWORD_SCAN_COMPLETE_${numOfWeakPasswords === 0 ? "NOT_" : numOfWeakPasswords > 1 ? "MULTI_" : "SINGLE_"}FOUND_BODY`,
      titleLocalKey: `WEAK_PASSWORD_SCAN_COMPLETE`,
      bodyLocalKey: `WEAK_PASSSWORD_SCAN_COMPLETE_${numOfWeakPasswords === 0 ? "NOT_" : numOfWeakPasswords > 1 ? "MULTI_" : "SINGLE_"}FOUND`,
      bodyLocalArgs: [numOfWeakPasswords, time],
      payload: {
        weakPasswordCount: numOfWeakPasswords,
        time
      },
      category: Constants.NOTIF_CATEGORY_WEAK_PASSWORD_SCAN
    });
  }

  getTasks() {
    for (const key of Object.keys(this.scheduledScanTasks)) {
      const ets = this.scheduledScanTasks[key].ets;
      if (ets && ets < Date.now() / 1000 - 86400)
        delete this.scheduledScanTasks[key];
    }
    return this.scheduledScanTasks;
  }

  async saveToRedis(hostId, result) {
    await rclient.setAsync(`weak_password_scan:${hostId}`, JSON.stringify(result));
  }

  async saveScanTasks() {
    const tasks = this.getTasks();
    await rclient.hsetAsync(Constants.REDIS_KEY_WEAK_PWD_RESULT, "tasks", JSON.stringify(tasks));
  }

  async setLastCompletedScanTs() {
    await rclient.hsetAsync(Constants.REDIS_KEY_WEAK_PWD_RESULT, "lastCompletedScanTs", Math.floor(Date.now() / 1000));
  }

  async getScanResult() {
    const result = await rclient.hgetallAsync(Constants.REDIS_KEY_WEAK_PWD_RESULT);
    if (!result)
      return {};
    if (_.has(result, "tasks"))
      result.tasks = JSON.parse(result.tasks);
    if (_.has(result, "lastCompletedScanTs"))
      result.lastCompletedScanTs = Number(result.lastCompletedScanTs);
    return result;
  }

  async checkDictionary() {
    let mkdirp = util.promisify(require('mkdirp'));
    const dictShaKey = "scan:config.sha256";
    const redisShaData = await rclient.getAsync(dictShaKey);
    let boneShaData = await bone.hashsetAsync(dictShaKey);
    //let boneShaData = Date.now() / 1000;
    if (boneShaData && boneShaData != redisShaData) {
      await rclient.setAsync(dictShaKey, boneShaData);

      log.info(`Loading dictionary from cloud...`);
      const data = await bone.hashsetAsync("scan:config");
      //const data = require('./scan_dict.json');
      log.debug('[checkDictionary]', data);
      if (data && data != '[]') {
        try {
          await mkdirp(scanDictPath);
        } catch (err) {
          log.error("Error when mkdir:", err);
          return;
        }

        const dictData = JSON.parse(data);
        if (!dictData) {
          log.error("Error to parse scan config");
          return;
        }
        // process customCreds, commonCreds
        await this._process_dict_creds(dictData);

        // process extraConfig (http-form-brute)
        await this._process_dict_extras(dictData.extraConfig);
      }
    }
  }

  async _process_dict_creds(dictData) {
    const commonUser = dictData.commonCreds && dictData.commonCreds.usernames || [];
    const commonPwds = dictData.commonCreds && dictData.commonCreds.passwords || [];
    const commonCreds = dictData.commonCreds && dictData.commonCreds.creds || [];

    const customCreds = dictData.customCreds;

    if (customCreds) {
      for (const key of Object.keys(customCreds)) {
        // eg. {firewalla}/run/scan_dict/*_users.lst
        let scanUsers = customCreds[key].usernames || [];
        if (_.isArray(scanUsers) && _.isArray(commonUser)) {
          scanUsers.push.apply(scanUsers, commonUser);
        }
        if (scanUsers.length > 0) {
          const txtUsers = _.uniqWith(scanUsers, _.isEqual).join("\n");
          if (txtUsers.length > 0) {
            await fsp.writeFile(scanDictPath + "/" + key.toLowerCase() + "_users.lst", txtUsers);
          }
        }

        // eg. {firewalla}/run/scan_dict/*_pwds.lst
        let scanPwds = customCreds[key].passwords || [];
        if (_.isArray(scanPwds) && _.isArray(commonPwds)) {
          scanPwds.push.apply(scanPwds, commonPwds);
        }
        if (scanPwds.length > 0) {
          const txtPwds = _.uniqWith(scanPwds, _.isEqual).join("\n");
          if (txtPwds.length > 0) {
            await fsp.writeFile(scanDictPath + "/" + key.toLowerCase() + "_pwds.lst", txtPwds);
          }
        }

        // eg. {firewalla}/run/scan_dict/*_creds.lst
        let scanCreds = customCreds[key].creds || [];
        if (_.isArray(scanCreds) && _.isArray(commonCreds)) {
          scanCreds.push.apply(scanCreds, commonCreds);
        }
        if (scanCreds.length > 0) {
          const txtCreds = _.uniqWith(scanCreds.map(i => i.user+'/'+i.password), _.isEqual).join("\n");
          if (txtCreds.length > 0) {
            await fsp.writeFile(scanDictPath + "/" + key.toLowerCase() + "_creds.lst", txtCreds);
          }
        }
      }
    }
  }

  async _process_dict_extras(extraConfig) {
    if (!extraConfig) {
      return;
    }
    await rclient.hsetAsync("sys:config", 'weak_password_scan', JSON.stringify(extraConfig));
  }

  _getCmdStdout(cmd, subTask) {
    return new Promise((resolve, reject) => {
      const r = cp.exec(cmd, (error, stdout, stderr) => {
        if (error) {
          reject(error)
        } else if (stderr.length > 0) {
          reject(stderr)
        } else {
          resolve(stdout)
        }
      })
      subTask.pid = r.pid;
    })
  }

  static multiplyScriptArgs(scriptArgs, extras) {
    let argList = [];
    for (const extra of extras) {
      let newArgs = scriptArgs.slice(0); // clone scriptArgs
      const {path, method, uservar, passvar} = extra;
      if (path) {
        newArgs.push('http-form-brute.path='+path);
      }
      if (method) {
        newArgs.push('http-form-brute.method='+method);
      }
      if (uservar) {
        newArgs.push('http-form-brute.uservar='+uservar);
      }
      if (passvar) {
        newArgs.push('http-form-brute.passvar='+passvar);
      }
      argList.push(newArgs);
    }
    return argList;
  }

  formatNmapCommand(ipAddr, port, cmdArg, scriptArgs) {
    if (scriptArgs && scriptArgs.length > 0) {
      cmdArg.push(util.format('--script-args %s', scriptArgs.join(',')));
    }
    // a bit longer than unpwdb.timelimit in script args
    return util.format('sudo timeout 5430s nmap -p %s %s %s -oX - | %s', port, cmdArg.join(' '), ipAddr, xml2jsonBinary);
  }

  _genNmapCmd_default(ipAddr, port, scripts) {
    let nmapCmdList = [];
    for (const bruteScript of scripts) {
      let cmdArg = [];
      cmdArg.push(util.format('--script %s', bruteScript.scriptName));
      if (bruteScript.otherArgs) {
        cmdArg.push(bruteScript.otherArgs);
      }
      let scriptArgs = [];
      if (bruteScript.scriptArgs) {
        scriptArgs.push(bruteScript.scriptArgs);
      }
      const cmd = this.formatNmapCommand(ipAddr, port, cmdArg, scriptArgs);
      nmapCmdList.push({cmd: cmd, bruteScript: bruteScript});
    }
    return nmapCmdList;
  }

  async _genNmapCmd_credfile(ipAddr, port, serviceName, scripts, extraConfig) {
    let nmapCmdList = [];
    const httpformbruteConfig = extraConfig && extraConfig['http-form-brute'];

    for (const bruteScript of scripts) {
      let scriptArgs = [];
      let needCustom = false;
      if (bruteScript.scriptArgs) {
        scriptArgs.push(bruteScript.scriptArgs);
      }
      if (bruteScript.scriptName.indexOf("brute") > -1) {
        const credsFile = scanDictPath + "/" + serviceName.toLowerCase() + "_creds.lst";
        if (await fsp.access(credsFile, fs.constants.F_OK).then(() => true).catch((err) => false)) {
          scriptArgs.push("brute.mode=creds,brute.credfile=" + credsFile);
          needCustom = true;
        }
      }
      if (needCustom == false) {
        continue;
      }

      // nmap -p 23 --script telnet-brute --script-args telnet-brute.timeout=8s,brute.mode=creds,brute.credfile=./creds.lst 192.168.1.103
      let cmdArg = [];
      cmdArg.push(util.format('--script %s', bruteScript.scriptName));
      if (bruteScript.otherArgs) {
        cmdArg.push(bruteScript.otherArgs);
      }

      // extends to a list of nmap commands, set http-form-brute script-args
      if (bruteScript.scriptName == 'http-form-brute') {
        if (httpformbruteConfig) {
          const dupArgs = InternalScanSensor.multiplyScriptArgs(scriptArgs, httpformbruteConfig);
          for (const newArgs of dupArgs) {
            const cmd = this.formatNmapCommand(ipAddr, port, cmdArg.slice(0), newArgs);
            nmapCmdList.push({cmd: cmd, bruteScript: bruteScript});
          }
          continue;
        }
      }

      const cmd = this.formatNmapCommand(ipAddr, port, cmdArg, scriptArgs);
      nmapCmdList.push({cmd: cmd, bruteScript: bruteScript});
    }
    return nmapCmdList;
  }

  async _genNmapCmd_userpass(ipAddr, port, serviceName, scripts, extraConfig) {
    let nmapCmdList = [];
    const httpformbruteConfig = extraConfig && extraConfig['http-form-brute'];

    for (const bruteScript of scripts) {
      let scriptArgs = [];
      let needCustom = false;
      if (bruteScript.scriptArgs) {
        scriptArgs.push(bruteScript.scriptArgs);
      }
      if (bruteScript.scriptName.indexOf("brute") > -1) {
        const scanUsersFile = scanDictPath + "/" + serviceName.toLowerCase() + "_users.lst";
        if (await fsp.access(scanUsersFile, fs.constants.F_OK).then(() => true).catch((err) => false)) {
          scriptArgs.push("userdb=" + scanUsersFile);
          needCustom = true;
        }
        const scanPwdsFile = scanDictPath + "/" + serviceName.toLowerCase() + "_pwds.lst";
        if (await fsp.access(scanPwdsFile, fs.constants.F_OK).then(() => true).catch((err) => false)) {
          scriptArgs.push("passdb=" + scanPwdsFile);
          needCustom = true;
        }
      }
      if (needCustom == false) {
        continue;
      }

      // nmap -p 22 --script telnet-brute --script-args telnet-brute.timeout=8s,userdb=./userpass/myusers.lst,passdb=./userpass/mypwds.lst 192.168.1.103
      let cmdArg = [];
      cmdArg.push(util.format('--script %s', bruteScript.scriptName));
      if (bruteScript.otherArgs) {
        cmdArg.push(bruteScript.otherArgs);
      }

      // extends to a list of nmap commands, set http-form-brute script-args
      if (bruteScript.scriptName == 'http-form-brute') {
        if (httpformbruteConfig) {
          const dupArgs = InternalScanSensor.multiplyScriptArgs(scriptArgs, httpformbruteConfig);
          for (const newArgs of dupArgs) {
            const cmd = this.formatNmapCommand(ipAddr, port, cmdArg.slice(0), newArgs);
            nmapCmdList.push({cmd: cmd, bruteScript: bruteScript});
          }
          continue;
        }
      }

      const cmd = this.formatNmapCommand(ipAddr, port, cmdArg, scriptArgs);
      nmapCmdList.push({cmd: cmd, bruteScript: bruteScript});
    }
    return nmapCmdList;
  }

  async genNmapCmdList(ipAddr, port, serviceName, scripts) {
    let nmapCmdList = []; // all nmap commands to run

    // prepare extra configs in advance (http-form-brute)
    const data = await rclient.hgetAsync('sys:config', 'weak_password_scan');
    const extraConfig = JSON.parse(data);

    // 1. compose default userdb/passdb (NO apply extra configs)
    const defaultCmds = this._genNmapCmd_default(ipAddr, port, scripts);
    if (defaultCmds.length > 0) {
      nmapCmdList = nmapCmdList.concat(defaultCmds);
    }

    // 2. compose customized credfile if necessary
    const credsCmds = await this._genNmapCmd_credfile(ipAddr, port, serviceName, scripts, extraConfig);
    if (credsCmds.length > 0) {
      nmapCmdList = nmapCmdList.concat(credsCmds);
    }

    // 3. compose customized userdb/passdb if necessary
    const userpassCmds = await this._genNmapCmd_userpass(ipAddr, port, serviceName, scripts, extraConfig);
    if (userpassCmds.length > 0) {
      nmapCmdList = nmapCmdList.concat(userpassCmds);
    }
    return nmapCmdList;
  }

  async nmapGuessPassword(ipAddr, config, hostId) {
    const { port, serviceName, protocol, scripts } = config;
    let weakPasswords = [];
    const initTime = Date.now() / 1000;

    const nmapCmdList = await this.genNmapCmdList(ipAddr, port, serviceName, scripts);
    log.debug("[nmapCmdList]", nmapCmdList.map(i=>i.cmd));

    // run nmap commands
    for (const nmapCmd of nmapCmdList) {
      const subTask = this.subTaskMap[hostId];
      // check if hostId exists in subTaskMap for each loop iteration, in case it is stopped halfway, hostId will be removed from subTaskMap
      if (!subTask) {
        log.warn("total used time: ", Date.now() / 1000 - initTime, 'terminate of unknown hostId', hostId, weakPasswords);
        return weakPasswords;
      }

      log.info("Running command:", nmapCmd.cmd);
      const startTime = Date.now() / 1000;
      try {
        let result;
        try {
          result = await this._getCmdStdout(nmapCmd.cmd, subTask);
        } catch (err) {
          log.error("command execute fail", err);
          if (err.code === 130 || err.signal === "SIGINT") { // SIGINT from stopWeakPasswordScanTask API
            log.warn("total used time: ", Date.now() / 1000 - initTime, 'terminate of signal');
            return weakPasswords;
          }
          continue;
        }
        let output = JSON.parse(result);
        let findings = null;
        if (nmapCmd.bruteScript.scriptName == "redis-info") {
          findings = _.get(output, `nmaprun.host.ports.port.service.version`, null);
          if (findings != null) {
            weakPasswords.push({username: "", password: ""});  //empty password access
          }
        } else {
          findings = _.get(output, `nmaprun.host.ports.port.script.table.table`, null);
          if (findings != null) {
            if (findings.constructor === Object)  {
              findings = [findings];
            }

            for (const finding of findings) {
              let weakPassword = {};
              finding.elem.forEach((x) => {
                switch (x.key) {
                  case "username":
                    weakPassword.username = x["#content"];
                    break;
                  case "password":
                    weakPassword.password = x["#content"];
                    break;
                  default:
                }
              });

              // verify weak password
              if (this.config.skip_verify === true ) {
                log.debug("[nmapGuessPassword] skip weak password, config.skip_verify", this.config.skip_verify);
                weakPasswords.push(weakPassword);
              } else {
                if (await this.recheckWeakPassword(ipAddr, port, nmapCmd.bruteScript.scriptName, weakPassword) === true) {
                  log.debug("weak password verified", weakPassword, ipAddr, port, nmapCmd.bruteScript.scriptName);
                  weakPasswords.push(weakPassword);
                } else {
                  log.warn("weak password false-positive detected", weakPassword, ipAddr, port, nmapCmd.bruteScript.scriptName);
                }
              }
            }
          }
        }        
      } catch (err) {
        log.error("Failed to nmap scan:", err);
      }
      log.info("used Time: ", Date.now() / 1000 - startTime);
    }

    log.debug("total used time: ", Date.now() / 1000 - initTime, weakPasswords);

    // remove duplicates
    return _.uniqWith(weakPasswords, _.isEqual);
  }

  async recheckWeakPassword(ipAddr, port, scriptName, weakPassword) {
    switch (scriptName) {
      case "http-brute":
        const credfile = scanDictPath + "/" + ipAddr + "_" + port + "_credentials.lst";
        const {username, password} = weakPassword;
        return await this.httpbruteCreds(ipAddr, port, username, password, credfile);
      default:
        return true;
    }
  }

  // check if username/password valid credentials
  async httpbruteCreds(ipAddr, port, username, password, credfile) {
    credfile = credfile || scanDictPath + "/tmp_credentials.lst";
    let creds;
    if (password == '<empty>') {
      creds = `${username}/`;
    } else {
      creds = `${username}/${password}`;
    }
    await execAsync(`rm -f ${credfile}`); // cleanup credfile in case of dirty data
    await fsp.writeFile(credfile, creds);
    if (! await fsp.access(credfile, fs.constants.F_OK).then(() => true).catch((err) => false)) {
        log.warn('fail to write credfile', ipAddr, port, username, credfile);
        return true; // if error, skip recheck
    }

    // check file content, skip to improve performance
    if (process.env.FWDEBUG) {
      const content = await execAsync(`cat ${credfile}`).then((result) => result.stdout.trim()).catch((err) => err.stderr);
      if (content != creds) {
        log.warn(`fail to write credfile, (user/pass=${username}/${password}, file=${content}, path ${credfile}`);
      }
    }

    const cmd = `sudo nmap -p ${port} --script http-brute --script-args unpwdb.timelimit=10s,brute.mode=creds,brute.credfile=${credfile} ${ipAddr} | grep "Valid credentials" | wc -l`
    const result = await execAsync(cmd);
    if (result.stderr) {
      log.warn(`fail to running command: ${cmd} (user/pass=${username}/${password}), err: ${result.stderr}`);
      return true;
    }

    await execAsync(`rm -f ${credfile}`); // cleanup credfile after finished
    log.info(`[httpbruteCreds] Running command: ${cmd} (user/pass=${username}/${password})`);
    return  result.stdout.trim() == "1"
  }
}

module.exports = InternalScanSensor;
