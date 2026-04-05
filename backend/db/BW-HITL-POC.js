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
    apiKey: "bu_LrjQmXPG8X-VmeZQGWP6-UZEVUEZV1K6psIQoXyjwDg"
});

// creates a profile
const profile = await client.profiles.create({
    "name": "Ant"
});
console.log(`Created profile with id ${profile.id}`);

// create session
const session = await client.sessions.create({
    keepAlive: true,
    profileId: profile.id
});
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

//cleanup
await client.sessions.stop(session.id);
await client.sessions.delete(session.id);

console.log("Cleaned up. now starting a new session with the same profile to check if login persists...");

// now we try to create a new session, but with the same profile ID to see
// if the cookies/localstorage persist and we can access the CAPE data without logging in again.
const session2 = await client.sessions.create({
    keepAlive: true,
    profileId: profile.id
});
console.log(`Live session: ${session2.liveUrl}`);

// request the same data. the new model and session doesn't have context of the old model, so we redo everything

const result3 = await client.run(
    `Please access the CAPE website again using the current session, and check if you are still logged in. If you are logged in, please search for "${profName}" in the CAPE website and extract the same data as before for class ${classname}. ***Please return the data in JSON format as the output.*** If you are not logged in, please respond with an error message indicating that the user is not logged in (error 123).`,
    { sessionId: session2.id }
);
console.log(result3.output);