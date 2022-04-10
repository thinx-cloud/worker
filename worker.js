let s = null;

if (typeof(process.env.SQREEN_TOKEN) !== "undefined") && (process.env.SQREEN_TOKEN !== null) {
    s = require('sqreen');
}

let r = null;

if (typeof(process.env.ROLLBAR_ACCESS_TOKEN) !== "undefined") && (process.env.ROLLBAR_ACCESS_TOKEN !== null) {
    var Rollbar = require('rollbar');
    r = new Rollbar({
        accessToken: process.env.ROLLBAR_ACCESS_TOKEN,
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

    if (r) r.info(["Worker started with server"+srv]);
}
