if (typeof(process.env.SQREEN_TOKEN) !== "undefined") {
    require('sqreen');
}

if (typeof(process.env.ROLLBAR_TOKEN) !== "undefined") {
    var Rollbar = require('rollbar');
    new Rollbar({
        accessToken: process.env.ROLLBAR_TOKEN,
        handleUncaughtExceptions: true,
        handleUnhandledRejections: true
    });
}

let Worker = require("./class.js");

// Init phase off-class

let srv = process.env.THINX_SERVER;
let worker = null;

if (typeof(srv) === "undefined" || srv === null) {
    console.log(`${new Date().getTime()} [critical] THINX_SERVER environment variable must be defined in order to build firmware with proper backend binding.`);
    process.exit(1);
} else {
    // fix missing http if defined in env file just like api:3000
    if (srv.indexOf("http") == -1) {
        srv = "http://" + srv;
    }
    console.log(`${new Date().getTime()} [info] » Starting build worker against ${srv}`);

    try {
        worker = new Worker(srv);
    } catch (e) {
        // in test environment there is a test worker running on additional port 3001 as well...
        console.log(`Caught exception ${e}`);
        let srv2 = srv1.replace(":3000", ":3001");
        // eslint-disable-next-line no-unused-vars
        worker = new Worker(srv2);
    }
}
