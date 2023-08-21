let r = null; // Rollbar

function exists(x) {
    return ((typeof(x) === "undefined") || (x === null)) ? false : true;
}

function undef(x) {
    return !exists(x);
}

if (exists(process.env.ROLLBAR_ACCESS_TOKEN)) {
    var Rollbar = require('rollbar');
    r = new Rollbar({
        accessToken: process.env.ROLLBAR_ACCESS_TOKEN,
        handleUncaughtExceptions: true,
        handleUnhandledRejections: true
    });
}

// Init phase off-class

let srv = process.env.THINX_SERVER;

if (undef(srv)) {
    console.log(`${new Date().getTime()} [critical] THINX_SERVER environment variable must be defined in order to build firmware with proper backend binding.`);
    process.exit(1);
} 

console.log(`${new Date().getTime()} [info] » Starting build worker against ${srv}`);

const Worker = require("./class.js");
// eslint-disable-next-line no-unused-vars

// Init phase off-class

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
        let srv2 = srv.replace(":3000", ":3001");
        // eslint-disable-next-line no-unused-vars
        worker = new Worker(srv2);
    }
}



if (exists(r)) r.info("Worker started", { context: "circle", environment: process.env.ENVIRONMENT, server: srv });
