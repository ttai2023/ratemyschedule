/**
 * @ file BW-HITL-POC.js
 * @description This file is the "Browser Use - 'Human in the Loop' Proof of
 * Concept"
 */

//hardcoding api key for now and testing, .env file later when nonpublic

import { BrowserUse } from "browser-use-sdk";
import "dotenv" // to load .env file and set process.env.BROWSER_USE_API_KEY

import * as readline from "readline";

const client = new BrowserUse({
    apiKey: process.env.BROWSER_USE_API_KEY
});

// create session
const session = await client.sessions.create();
console.log(`Live session: ${session.liveUrl}`);

//boiler
const profName = "Curt";
const dept = "ECE";
const classname = "ECE 35";

const capeSearchResult = await client.run(
    `Visit \`https://cape.ucsd.edu/responses/Results.aspx\` and search for
    "${profName}", department "${dept}". When results are shown, view
    class ${classname} if it exists, and extract the percentages for
    "Recommend Class", "Recommend Instructor", "Study Hrs/Wk", 
    "Expected Grade", and "Recieved Grade". ***Return the data as JSON with these
    parameters.*** If it asks for login, respond that the user needs to login (error 123).`,
    { sessionId: session.id }
);

console.log(capeSearchResult.output);

// wait for user to login
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
await new Promise((resolve) => 
    rl.question("Please login to the CAPE website and press Enter to continue...", resolve));
rl.close();


// continue task
const result2 = await client.run(
    `Now that you're logged in, please continue with the task of searching for "${profName}" in the CAPE website and extracting the relevant data. ***Please remember to put it in JSON format as the output.*** If you have already done this, please review the data you extracted and make sure it's correct. If you encounter any issues, please describe them in detail.`,
    { sessionId: session.id }
);
console.log(result2.output);

//cleanu
await client.sessions.stop(session.id);
