'use strict'

const endpoint = '/' + require("path").basename(__filename, '.js');

module.exports = function(router, netbotHandler) {
    router.get(endpoint, (req, res) => {
        let body = {};
        netbotHandler(req._gid, body, res);
    });
}
