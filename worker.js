let s = null; // Sqreen
let r = null; // Rollbar

function exists(x) {
    return ((typeof(x) === "undefined") || (x === null)) ? false : true;
}

if (exists(process.env.SQREEN_TOKEN)) {
    s = require('sqreen');
}

if (exists(process.env.ROLLBAR_ACCESS_TOKEN)) {
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

if (undef(srv)) {
    console.log(`${new Date().getTime()} [critical] THINX_SERVER environment variable must be defined in order to build firmware with proper backend binding.`);
    process.exit(1);
} 

console.log(`${new Date().getTime()} [info] » Starting build worker against ${srv}`);
worker = new Worker(srv);

if (exists(r)) r.info(["Worker started with server"+srv]);
