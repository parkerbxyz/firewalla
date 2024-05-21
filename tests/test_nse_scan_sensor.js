/*    Copyright 2016-2024 Firewalla Inc.
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

'use strict'

let chai = require('chai');
let expect = chai.expect;

const Constants = require('../net2/Constants.js');
const fireRouter = require('../net2/FireRouter.js')
const Host = require('../net2/Host.js');
const HostManager = require('../net2/HostManager.js');
const NetworkProfile = require('../net2/NetworkProfile.js');
const npm = require('../net2/NetworkProfileManager.js');
const log = require('../net2/logger.js')(__filename);
const sysManager = require('../net2/SysManager.js');
const NseScanPlugin = require('../sensor/NseScanPlugin.js');
const rclient = require('../util/redis_manager.js').getRedisClient();

process.title = "FireMain"
const hostManager = new HostManager();

async function _setIntfPolicy(uuid, policy) {
  const networkProfile = npm.getNetworkProfile(uuid);
  await networkProfile.setPolicyAsync('nse_scan', policy);
}

describe('Test NseScanPlugin', function() {
  this.timeout(1200000);
  this.plugin = new NseScanPlugin({});

  beforeEach((done) => (
    async() => {
      this.policy = await rclient.hgetAsync('policy:system', 'nse_scan');
      fireRouter.scheduleReload();
      await new Promise(resolve => setTimeout(resolve, 2000));
      await sysManager.updateAsync();
      const keys = await rclient.keysAsync("network:uuid:*");
      for (let key of keys) {
        const profile = await rclient.hgetallAsync(key);
        if (!profile) // just in case
          continue;
        const o = NetworkProfile.parse(profile);
        const uuid = key.substring(13);
        if (!uuid) {
          continue;
        }
        o.uuid = uuid;
        npm.networkProfiles[uuid] = new NetworkProfile(o)
      }

      const hostkeys = await rclient.keysAsync("host:mac:*");
      const currentTs = Date.now() / 1000;
      for (let key of hostkeys) {
        const hostinfo = await rclient.hgetallAsync(key);
        const host = new Host(hostinfo, true);
        host.lastActiveTimestamp = currentTs;
        hostManager.hostsdb[`host:mac:${host.mac}`] = host
        hostManager.hosts.all.push(host);
      }
      await rclient.hdelAsync(Constants.REDIS_KEY_NSE_RESULT, 'key1');
      done();
    })()
  );

  afterEach((done) => (
    async() => {
      await rclient.hsetAsync('policy:system', 'nse_scan', this.policy);
      done();
    })()
  );

  it('should get last result', async() => {
    const ts = Date.now()/1000;
    const content = '{"dhcp_3":{"ts":'+(ts-100)+',"results":{"br3":{}}},"dhcp_4.568":{"ts":'+ts+',"results":{"br4":{}}},"dhcp_1.568":{"ts":'+(ts-300)+',"results":{"br1":{}}},"dhcp_2.568":{"ts":'+(ts-200)+',"results":{"br2":{}}}}';
    await rclient.hsetAsync(Constants.REDIS_KEY_NSE_RESULT, 'dhcp', content);
    const result = await this.plugin.getLastNseResult('dhcp');
    expect(result.lastResult).to.eql({"br4":{}});
    expect(result.alarm).to.be.false;
  });

  it('should exec broadcast-dhcp-discover', async() =>{
    const results = await this.plugin.execNse('broadcast-dhcp-discover');
    log.debug('broadcast-dhcp-discover', JSON.stringify(results));
    expect(results.length).to.be.not.equal(0);
  });

  it('should exec dhcp-discover', async() =>{
    const results = await this.plugin.execNse('dhcp-discover');
    log.debug('dhcp-discover', JSON.stringify(results));
    expect(results.length).to.be.not.equal(0);
  });

  it('should run dhcp once', async() => {
    await rclient.delAsync(Constants.REDIS_KEY_NSE_RESULT);
    const interfaces = sysManager.getInterfaces(false);
    for (const intf of interfaces) {
      await _setIntfPolicy(intf.uuid, {state: false});
    }
    await this.plugin.runOnceDhcp();
    const results = await rclient.hgetAsync(Constants.REDIS_KEY_NSE_RESULT, 'dhcp');
    expect(results).to.not.empty;
  })

  it('should run cron job', async() => {
    const interfaces = sysManager.getInterfaces(false);
    for (const intf of interfaces) {
      if (intf.name == "br0") {
        await _setIntfPolicy(intf.uuid, {"state": true, "dhcp":true});
      }
      else {
        await _setIntfPolicy(intf.uuid, {state: false});
      }
    }
    await this.plugin.runCronJob('dhcp', true);
    const results = await rclient.hgetAsync(Constants.REDIS_KEY_NSE_RESULT, 'dhcp');
    expect(results).to.not.empty;
  })

  it('should check results', () => {
    const results = {
      "br0":{
        "192.168.196.105":[{"serverIdentifier": "192.168.196.105","interface": "br0","local": false, "target":"mac:a1:b2:c3:d4"},{"serverIdentifier": "192.168.196.105","target": "broadcast:a"}],
        "192.168.196.1": [{"serverIdentifier": "192.168.196.1","interface": "br0","local": true, "target":"mac:aa:bb:cc:dd"}]},
      "eth0.204": {
        "192.168.10.254": [{"serverIdentifier": "192.168.10.254", "interface": "eth0.204","target": "broadcast:1"}]},
      "eth0":{
        "192.168.23.1":[{"serverIdentifier": "192.168.23.1","interface": "eth0", "target": "broadcast:2"}]}}
    const checkResult = this.plugin.checkDhcpResult(results);
    expect(checkResult.alarm).to.be.true;
    expect(checkResult.suspects).to.be.eql([{"serverIdentifier": "192.168.196.105","interface": "br0","local": false, "target":"mac:a1:b2:c3:d4"}]);
  })

  it('should save nse results', async() => {
    await this.plugin.saveNseResults('key1', {}, Date.now()/1000);
    const content = await rclient.hgetAsync(Constants.REDIS_KEY_NSE_RESULT, 'key1');
    log.debug('nse results', content);
    expect(content).to.be.contains(`"spendtime":0`);
    await rclient.hdelAsync(Constants.REDIS_KEY_NSE_RESULT, 'key1');
  })

  it('should save host nse result', async() => {
    const currentTs = Date.now()/1000;
    await rclient.hsetAsync('nse_scan:mac:aaaa', 'key1', `{"ts": ${currentTs  - 2992000}}`);
    await rclient.hsetAsync('nse_scan:mac:123456', 'key1', `{"ts": ${currentTs  - 2992000}}`);
    await this.plugin.saveHostNseResults('key1', {"eth1": {"ip":[{target: "mac:123456", ts: currentTs}]}});
  });

  it('should save suspect nse result', async() => {
    const ts = Date.now()/1000;
    await rclient.hsetAsync('nse_scan:suspect:aaaa', 'key1', "{}");
    await rclient.hsetAsync('nse_scan:suspect:123456', 'key1', "{}");
    await this.plugin.saveNseSuspects('key1', [{target: "mac:123456", ts: ts}]);
  });

  it('should get dhcp results', async() => {
    const ts = Date.now()/1000;
    const content = '{"key_2": {"ts": 1716190958}, "dhcp_1716282358.568":{"ts":'+ts+',"results":{"br0":{"ip":[]}}}}'
    await rclient.hsetAsync(Constants.REDIS_KEY_NSE_RESULT, 'dhcp', content);

    const results = await this.plugin.getNseResults('dhcp');
    expect(Object.keys(results).length).to.be.equal(1);
    expect(Object.entries(results)[0][0]).to.be.equal('dhcp_1716282358.568');
  })
});

describe('Test applyPolicy', function(){
  this.timeout(10000);
  this.plugin = new NseScanPlugin({});

  beforeEach((done) => {
    (async() =>{
      await rclient.hsetAsync('policy:system', 'nse_scan', '{"state": false}');
      done();
    })();
  });

  afterEach((done) => {
    (async() => {
      done();
    })();
  });

  it('should apply policy', async() => {
    const now = Date.now() / 1000;
    await this.plugin.applyPolicy(hostManager, '0.0.0.0', {state: true, cron: '1 * * * *', ts:now});

    await this.plugin.applyPolicy(hostManager, '0.0.0.0', {state: false});
  });

  it('should check policy', () => {
    expect(this.plugin._checkNetworkNsePolicy('uuid', 'key1')).to.be.true;
    expect(this.plugin._checkNsePolicy({}, 'key1')).to.be.true;
    expect(this.plugin._checkNsePolicy({'nse_scan': {}}, 'key1')).to.be.false;
    expect(this.plugin._checkNsePolicy({'nse_scan': {state: false}}, 'key1')).to.be.false;
    expect(this.plugin._checkNsePolicy({'nse_scan': {state: true}}, 'key1')).to.be.true;
    expect(this.plugin._checkNsePolicy({'nse_scan': {state: true, key1: 1 }}, 'key1')).to.be.false;
    expect(this.plugin._checkNsePolicy({'nse_scan': {state: true, key1: true }}, 'key1')).to.be.true;
    expect(this.plugin._checkNsePolicy({'nse_scan': {state: true, key1: false }}, 'key1')).to.be.false;
  });

});