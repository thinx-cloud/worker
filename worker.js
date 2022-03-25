let s;

if (typeof(process.env.SQREEN_TOKEN) !== "undefined") {
    s = require('sqreen');
}

let r;

if (typeof(process.env.ROLLBAR_TOKEN) !== "undefined") {
    var Rollbar = require('rollbar');
    r = new Rollbar({
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
    console.log(`${new Date().getTime()} [info] » Starting build worker against ${srv}`);

    worker = new Worker(srv);

    r.info(["Worker started with server"+srv]);
}
