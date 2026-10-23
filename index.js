#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { createInterface } from "node:readline/promises";
import ignore from "ignore";
import { Command } from "commander";
import { marked } from "marked";
import { markedTerminal } from "marked-terminal";
import OpenAI from "openai";

const configDir = path.dirname(fileURLToPath(import.meta.url));
const state = fs.existsSync(path.join(configDir, ".state.json")) ? JSON.parse(fs.readFileSync(path.join(configDir, ".state.json"), "utf8")) : {};
state.profiles ??= {};
state.apiKeys ??= {};
if (!state.apiKeys.openai && fs.existsSync(path.join(configDir, ".env"))) {
	const env = parseEnv(fs.readFileSync(path.join(configDir, ".env"), "utf8"));
	if (env.OPENAI_API_KEY) {
		state.apiKeys.openai = env.OPENAI_API_KEY;
	}
}
const promptForApiKey = async (provider) => {
	const readline = createInterface({ input: process.stdin, output: process.stdout });
	try {
		state.apiKeys[provider] = (await readline.question("Enter your API key: ")).trim();
	}
	finally {
		readline.close();
	}
};
const saveState = () => {
	fs.writeFileSync(path.join(configDir, ".state.json"), JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 });
	fs.chmodSync(path.join(configDir, ".state.json"), 0o600);
};

const slaveignore = ignore();
if (fs.existsSync(".slaveignore")) {
	slaveignore.add(fs.readFileSync(".slaveignore", "utf8").replaceAll("/\n", "\n"));
}
const gitignore = ignore();
if (fs.existsSync(".gitignore")) {
	gitignore.add(fs.readFileSync(".gitignore", "utf8").replaceAll("/\n", "\n"));
}
const isOutOfReach = (p, type) => {
	const rel = path.relative(".", p);
	if (rel.startsWith("..") || path.isAbsolute(rel)) {
		return true;
	}
	const segs = rel.split(path.sep);
	if (segs.includes(".env") || segs.includes(".git")) {
		return true;
	}
	if (rel && (slaveignore.ignores(rel) || (type == "write" && gitignore.ignores(rel)))) {
		return true;
	}
	return false;
};

const readFileForModel = (filePath) => fs.readFileSync(filePath, "utf8").replaceAll("\r\n", "\n");
const writeFileFromModel = (filePath, data, usesCRLF) => {
	if (fs.existsSync(filePath)) {
		if (usesCRLF === undefined) {
			usesCRLF = fs.readFileSync(filePath, "utf8").includes("\r\n");
		}
	}
	else {
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
	}
	const normalized = data.replaceAll("\r\n", "\n");
	fs.writeFileSync(filePath, usesCRLF ? normalized.replaceAll("\n", "\r\n") : normalized, "utf8");
};

let used_docker;
const ensureSandbox = () => {
	if (!used_docker) {
		try {
			// `docker pull ghcr.io/calamity-inc/slave-sandbox` is not needed to get the image, but would be needed to update it.
			execFileSync("docker", ["run", "-d", "--name", "slave-sandbox", "ghcr.io/calamity-inc/slave-sandbox", "sleep", "infinity"], { encoding: "utf8" });
		}
		catch (e) {
			// container may already exist if it was not cleaned up previously. this is okay-ish.
		}
		used_docker = true;
	}
};

const functions = {
	ls: ({ path }) => {
		path ??= ".";
		if (isOutOfReach(path)) {
			return "Out of your reach";
		}
		let files;
		try {
			files = fs.readdirSync(path, { withFileTypes: true });
		}
		catch (e) {
			return e.code;
		}
		return JSON.stringify(files.map(dirent => dirent.isDirectory() ? `${dirent.name}/` : dirent.name));
	},
	findFiles: ({ path, substring, recursive }) => {
		path ??= ".";
		if (isOutOfReach(path)) {
			return "Out of your reach";
		}
		let files;
		try {
			files = fs.readdirSync(path, { withFileTypes: true, recursive });
		}
		catch (e) {
			return e.code;
		}
		files = files.filter(dirent => dirent.isFile())
			.map(dirent => {
				if (dirent.parentPath != ".") {
					return `${dirent.parentPath.replaceAll("\\", "/")}/${dirent.name}`
				}
				return dirent.name;
			})
			.filter(file => !isOutOfReach(file));
		const res = [];
		for (const file of files) {
			const matches = readFileForModel(file).split(substring).length - 1;
			if (matches) {
				res.push(`${file} has ${matches} match${matches == 1 ? "" : "es"}`);
			}
		}
		return res.join("\n");
	},
	readFile: ({ path }) => {
		if (isOutOfReach(path)) {
			return "You don't have read access to this file";
		}
		return readFileForModel(path);
	},
	writeFile: ({ path, data }) => {
		if (isOutOfReach(path, "write")) {
			return "You don't have write access to this file";
		}
		writeFileFromModel(path, data);
		return "OK";
	},
	fileFindAndReplace: ({ path, substring, replacement, expectedMatches }) => {
		if (isOutOfReach(path, "write")) {
			return "You don't have write access to this file";
		}
		const fileContent = fs.readFileSync(path, "utf8");
		const usesCRLF = fileContent.includes("\r\n");
		const arr = fileContent.replaceAll("\r\n", "\n").split(substring);
		const matches = arr.length - 1;
		if (matches == 0 || (expectedMatches && matches != expectedMatches)) {
			return `There were ${matches} match${matches == 1 ? "" : "es"}`;
		}
		writeFileFromModel(path, arr.join(replacement), usesCRLF);
		return "OK";
	},
	sandboxExec: ({ command, args }) => {
		ensureSandbox();
		const result = spawnSync("docker", [ "exec", "slave-sandbox", command, ...args ], { encoding: "utf8" });
		const output = (result.stdout ?? "") + (result.stderr ?? "");
		if (result.error) {
			return (output || result.error.message).trimEnd();
		}
		if (result.status !== 0 && !output) {
			return `Command exited with status ${result.status}`;
		}
		return output;
	},
	sandboxCopyIn: ({ hostPath, sbxPath }) => {
		if (isOutOfReach(hostPath)) {
			return "You don't have read access to this file";
		}
		if (!fs.existsSync(hostPath) || !fs.statSync(hostPath).isFile()) {
			return "Host path must point to a file";
		}
		ensureSandbox();
		try {
			execFileSync("docker", ["cp", "-L", hostPath, `slave-sandbox:${sbxPath}`], { encoding: "utf8" });
			return "OK";
		}
		catch (e) {
			return (e.stdout ?? e.message).trimEnd();
		}
	},
	sandboxCopyOut: ({ sbxPath, hostPath }) => {
		if (isOutOfReach(hostPath, "write")) {
			return "You don't have write access to this file";
		}
		if (fs.existsSync(hostPath) && !fs.statSync(hostPath).isFile()) {
			return "Host path must point to a file";
		}
		ensureSandbox();
		execFileSync("docker", ["cp", "-L", `slave-sandbox:${sbxPath}`, hostPath], { encoding: "utf8" });
		return "OK";
	},
	/*system: ({ command }) => {
		//process.exit(1);
		return "It's interesting that you called this tool! Unfortunately for you, it does nothing.";
	}*/
};

let tools = [
	{
		type: "function",
		name: "ls",
		description: "Lists files",
		parameters: {
			type: "object",
			properties: {
				path: { type: ["string", "null"] },
			},
			required: [ "path" ],
			additionalProperties: false,
		},
		strict: true,
	},
	{
		type: "function",
		name: "findFiles",
		parameters: {
			type: "object",
			properties: {
				path: { type: ["string", "null"] },
				substring: { type: "string" },
				recursive: { type: ["boolean", "null"] },
			},
			required: [ "path", "substring", "recursive" ],
			additionalProperties: false,
		},
		strict: true,
	},
	{
		type: "function",
		name: "readFile",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string" },
			},
			required: [ "path" ],
			additionalProperties: false,
		},
		strict: true,
	},
	{
		type: "function",
		name: "writeFile",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string" },
				data: { type: "string" },
			},
			required: [ "path", "data" ],
			additionalProperties: false,
		},
		strict: true,
	},
	{
		type: "function",
		name: "fileFindAndReplace",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string" },
				substring: { type: "string" },
				replacement: { type: "string" },
				expectedMatches: { type: ["number", "null"] },
			},
			required: [ "path", "substring", "replacement", "expectedMatches" ],
			additionalProperties: false,
		},
		strict: true,
	},
	{
		type: "function",
		name: "sandboxExec",
		description: "Runs a command without Bash. Note that commands in the sandbox don't access the user's filesystem but you can copy in and out of it.",
		parameters: {
			type: "object",
			properties: {
				command: { type: "string" },
				args: { type: "array", items: { type: "string" } },
			},
			required: [ "command", "args" ],
			additionalProperties: false,
		},
		strict: true,
	},
	{
		type: "function",
		name: "sandboxCopyIn",
		parameters: {
			type: "object",
			properties: {
				hostPath: { type: "string" },
				sbxPath: { type: "string" },
			},
			required: [ "hostPath", "sbxPath" ],
			additionalProperties: false,
		},
		strict: true,
	},
	{
		type: "function",
		name: "sandboxCopyOut",
		parameters: {
			type: "object",
			properties: {
				sbxPath: { type: "string" },
				hostPath: { type: "string" },
			},
			required: [ "sbxPath", "hostPath" ],
			additionalProperties: false,
		},
		strict: true,
	},
	// This is useful to see where the model maybe expects a better tool:
	/*{
		type: "function",
		name: "system",
		parameters: {
			type: "object",
			properties: {
				command: { type: "string" },
			},
			required: [ "command" ],
			additionalProperties: false,
		},
		strict: true,
	},*/
];

const generateResponseOptionallyUsingTools = async (client, model, input, previous_response_id) => {
	let response = await client.responses.create({
		model,
		previous_response_id,
		input,
		tools,
	});
	let used_tools = false;

	while (true) {
		const toolCalls = response.output.filter((item) => item.type === "function_call");
		if (toolCalls.length == 0) {
			break;
		}

		const outputs = toolCalls.map((call) => {
			console.log("$ " + call.name + call.arguments);
			const output = String(functions[call.name](JSON.parse(call.arguments)));
			let consoleOutput = output.replaceAll("\r", "<CR>").replaceAll("\n", "<NL>");
			if (call.name == "readFile" && consoleOutput.length > 80) {
				consoleOutput = consoleOutput.substring(0, 77) + "...";
			}
			console.log(consoleOutput);
			return {
				type: "function_call_output",
				call_id: call.call_id,
				output,
			};
		});

		response = await client.responses.create({
			model,
			previous_response_id: response.id,
			input: outputs,
			tools,
		});
		used_tools = true;
	}

	response.used_tools = used_tools;
	return response;
};

marked.use(markedTerminal());
const markdownToConsoleText = (md) => {
	const _console_error = console.error; // prevent unintended output about unknown languages, e.g. "```env\ndeez\n```\n"
	console.error = undefined;
	const text = marked.parse(md).trimEnd() + "\n";
	console.error = _console_error;
	return text;
};


const program = new Command();
program
	.name("slave")
	.usage("[options] [--] [prompt...]")
	.description("Vibe coding without the kaboom factor.")
	.argument("[prompt...]")
	.option("-c, --continue", "add your previous invocation to the context of this one").option("--cont")
	.option("--amend", "retry the previous invocation, using the context from before it")
	.option("-w, --web", "allow the model to search the web")
	.option("-n, --no-fs", "disable filesystem access").option("--nofs")
	.option("-p, --profile <name>", "profile name", "default")
	.option("--create-profile <name> <provider> <model>", "create a profile")
	.option("--delete-profile <name>", "delete a profile") // TODO
	.option("--update-api-key <provider>", "update an API key") // TODO
	.helpOption("-?, --help", "display help")
	.parse();
const options = program.opts();

if (options.createProfile) {
	if (!program.args[0] || !program.args[1]) {
		console.log("Syntax: slave --create-profile <name> <provider> <model>");
		process.exit(1);
	}
	const provider = program.args[0];
	if (provider != "openai" && !provider.startsWith("http://") && !provider.startsWith("https://")) {
		console.log(`Invalid provider: ${provider}`);
		process.exit(1);
	}
	const isCreate = !(options.createProfile in state.profiles);
	state.profiles[options.createProfile] = { provider, model: program.args[1] };
	if (!state.apiKeys[provider]) {
		await promptForApiKey(provider);
	}
	saveState();
	console.log(`${isCreate ? "Created" : "Updated"} ${options.createProfile} profile.`);
	process.exit(0);
}
if (options.deleteProfile) {
	delete state.profiles[options.deleteProfile];
	saveState();
	console.log(`Deleted ${options.deleteProfile} profile.`);
	process.exit(0);
}
if (options.updateApiKey) {
	await promptForApiKey(options.updateApiKey);
	saveState();
	console.log("Saved.");
	process.exit(0);
}

const profile = state.profiles[options.profile];
if (!profile) {
	if (options.profile == "default") {
		console.log(markdownToConsoleText("You did not specify a profile, but a default profile does not exist. Use e.g. `slave --create-profile default openai gpt-6-luna` to create one."));
	}
	else {
		console.log(markdownToConsoleText(`No such profile. Use e.g. \`slave --create-profile ${options.profile} openai gpt-6-luna\` to create it.`));
	}
	process.exit(1);
}

let prompt = program.args.join(" ").trim();
let previous_response_id;
const overrides = [profile.provider.startsWith("http") ? `${profile.model} via ${profile.provider}` : `${profile.provider}/${profile.model}`];
if (options.continue || options.cont) {
	previous_response_id = state.previous_response_id;
}
else if (options.amend) {
	previous_response_id = state.previous_previous_response_id;
}
if (options.web) {
	tools.push({ type: "web_search" });
	overrides.push("web search enabled");
}
if (options.fs == false || options.nofs) {
	tools = tools.filter(tool => tool.type != "function");
	overrides.push("no filesystem access");
}
let stdinText = "";
if (!process.stdin.isTTY) {
	const chunks = [];
	for await (const chunk of process.stdin) {
		chunks.push(chunk);
	}
	stdinText = Buffer.concat(chunks).toString("utf8");
}
if (!prompt) {
	console.log("No prompt given.");
	process.exit(1);
}

console.log((previous_response_id ? "FOLLOW-UP" : "PROMPT") + ": " + prompt);
if (stdinText) {
	overrides.push("stdin provided");
	prompt = `${stdinText}\n\n${prompt}`;
}
console.log(`(${overrides.join(", ")})\n`);

//console.log({ model: profile.model, prompt, previous_response_id });

const clientOpts = {
	apiKey: state.apiKeys[profile.provider],
};
if (profile.provider != "openai") {
	clientOpts.baseURL = profile.provider;
	clientOpts.apiKey ||= "dummy";
}
const client = new OpenAI(clientOpts);
const response = await generateResponseOptionallyUsingTools(client, profile.model, prompt, previous_response_id);
state.previous_previous_response_id = previous_response_id;
state.previous_response_id = response.id;
saveState();
if (response.used_tools) {
	if (used_docker) {
		execFileSync("docker", ["rm", "-f", "slave-sandbox"], { encoding: "utf8" });
	}
	console.log();
}
console.log(markdownToConsoleText(response.output_text) + "\n");
