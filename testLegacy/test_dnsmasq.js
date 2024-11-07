/**
 * Created by Melvin Tu on 11/01/2017.
 */

'use strict';

let fs = require('fs');
let chai = require('chai');
let expect = chai.expect;

let f = require('../net2/Firewalla.js');

let DNSMASQ = require('../extension/dnsmasq/dnsmasq.js');
let dnsmasq = new DNSMASQ();

dnsmasq.cleanUpPolicyFilter()
  .then(() => {
    dnsmasq.updateFilter();

    dnsmasq.addPolicyFilterEntry("test.com")
      .then(() => {

        dnsmasq.addPolicyFilterEntries(["test2.com", "test3.com"])
          .then(() => {
            console.log(fs.readFileSync("~/.firewalla/config/dns/policy_filter.conf").toString("utf8"));
            
            dnsmasq.start(false, (err) => {
              expect(err).to.equal(undefined);
              process.exit(0);
            })
          });
      });
  });

setTimeout(() => {
  expect(1).to.equal(0);
  process.exit(1);
}, 3000);