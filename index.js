#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";

import Anthropic from "@anthropic-ai/sdk";
import { Command } from "commander";
import envPaths from "env-paths";
import ignore from "ignore";
import { marked } from "marked";
import { markedTerminal } from "marked-terminal";
import OpenAI from "openai";


const configDir = envPaths("slave").data;
const state = fs.existsSync(path.join(configDir, "state.json")) ? JSON.parse(fs.readFileSync(path.join(configDir, "state.json"), "utf8")) : {};
state.profiles ??= {};
state.apiKeys ??= {};
state.providerStates ??= {};
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
	fs.mkdirSync(configDir, { recursive: true });
	fs.writeFileSync(path.join(configDir, "state.json"), JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 });
	fs.chmodSync(path.join(configDir, "state.json"), 0o600);
};

const slaveignore = ignore();
if (fs.existsSync(".slaveignore")) {
	slaveignore.add(fs.readFileSync(".slaveignore", "utf8").replaceAll("/\n", "\n"));
}
const gitignore = ignore();
if (fs.existsSync(".gitignore")) {
	gitignore.add(fs.readFileSync(".gitignore", "utf8").replaceAll("/\n", "\n"));
}
const isOutOfReach = (p, accessType) => {
	const rel = path.relative(".", p);
	if (rel.startsWith("..") || path.isAbsolute(rel)) {
		return true;
	}
	const segs = rel.split(path.sep);
	if (segs.includes(".env") || segs.includes(".git")) {
		return true;
	}
	if (rel && (slaveignore.ignores(rel) || (accessType == "write" && gitignore.ignores(rel)))) {
		return true;
	}
	return false;
};

const fixPath = (path, accessType) => {
	if (path.startsWith("/")) {
		path = path.substring(1);
		path ||= ".";
	}
	return isOutOfReach(path, accessType) ? "" : path;
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
		path = fixPath(path);
		if (!path) {
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
		path = fixPath(path);
		if (!path) {
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
		path = fixPath(path);
		if (!path) {
			return "You don't have read access to this file";
		}
		if (!fs.existsSync(path) || !fs.statSync(path).isFile()) {
			return "No such file";
		}
		return readFileForModel(path);
	},
	writeFile: ({ path, data }) => {
		path = fixPath(path, "write");
		if (!path) {
			return "You don't have write access to this file";
		}
		writeFileFromModel(path, data);
		return "OK";
	},
	fileFindAndReplace: ({ path, substring, replacement, expectedMatches }) => {
		path = fixPath(path, "write");
		if (!path) {
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
		hostPath = fixPath(hostPath);
		if (!hostPath) {
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
		hostPath = fixPath(hostPath, "write");
		if (!hostPath) {
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

const tools = [];
const initTools = (fs, sandbox, web_search) => {
	if (fs) {
		tools.push(
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
		);
	}
	if (sandbox) {
		tools.push({
			type: "function",
			name: "sandboxExec",
			description: "Runs a command without Bash in an isolated sandbox.",
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
		});
		if (fs) {
			tools.push(
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
			);
		}
	}
	if (web_search) {
		tools.push({ type: "web_search" });
	}
};

const toolToAnthropic = (t) => {
	if (t.type == "function") {
		return {
			name: t.name,
			description: t.description,
			input_schema: {
				type: t.parameters.type,
				properties: t.parameters.properties,
			}
		};
	}
	else if (t.type == "web_search") {
		return {
			type: "web_search_20260318",
			name: "web_search"
		};
	}
};

const useTool = (name, args, argsStr) => {
	console.log("$ " + name + argsStr);
	const output = String(functions[name](args));
	let consoleOutput = output.replaceAll("\r", "<CR>").replaceAll("\n", "<NL>");
	if (name == "readFile" && consoleOutput.length > 80) {
		consoleOutput = consoleOutput.substring(0, 77) + "...";
	}
	console.log(consoleOutput);
	return output;
};

const openai_generateResponseOptionallyUsingTools = async (client, model, input, state) => {
	let response = await client.responses.create({
		model,
		previous_response_id: state,
		input,
		tools,
	});
	let used_tools = false;

	while (true) {
		const toolCalls = response.output.filter((item) => item.type == "function_call");
		if (toolCalls.length == 0) {
			break;
		}

		const outputs = toolCalls.map((call) => {
			return {
				type: "function_call_output",
				call_id: call.call_id,
				output: useTool(call.name, JSON.parse(call.arguments), call.arguments)
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

	return {
		output_text: response.output_text,
		state: response.id,
		used_tools,
	};
};

const anthropic_generateResponseOptionallyUsingTools = async (client, model, input, state) => {
	state = JSON.parse(state || "[]");
	state.push({ role: "user", content: input });
	let used_tools = false;

	const anthropicTools = tools.map(t => toolToAnthropic(t));

	let message = await client.messages.create({
		model,
		max_tokens: 4096,
		cache_control: { type: "ephemeral" },
		messages: state,
		tools: anthropicTools,
	});
	state.push({ role: message.role, content: message.content });

	while (message.stop_reason == "tool_use" || message.stop_reason == "max_tokens" || message.stop_reason == "pause_turn") {
		const toolCalls = message.content.filter((item) => item.type == "tool_use");
		if (toolCalls.length) {
			const outputs = toolCalls.map((call) => {
				return {
					type: "tool_result",
					tool_use_id: call.id,
					content: useTool(call.name, call.input, JSON.stringify(call.input))
				};
			});
			state.push({ role: "user", content: outputs });
			used_tools = true;
		}

		message = await client.messages.create({
			model,
			max_tokens: 4096,
			cache_control: { type: "ephemeral" },
			messages: state,
			tools: anthropicTools,
		});
		state.push({ role: message.role, content: message.content });
	}

	//console.log(message);
	return {
		output_text: message.content.find((item) => item.type == "text").text,
		state: JSON.stringify(state),
		used_tools,
	};
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
	.option("-a, --amend", "retry the previous invocation, using the context from before it")
	.option("-w, --web", "allow the model to search the web")
	.option("-n, --no-fs", "disable filesystem access").option("--nofs")
	.option("-s, --sandbox", "allow the model to use a docker container")
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
	if (provider != "openai" && provider != "anthropic" && !provider.startsWith("http://") && !provider.startsWith("https://")) {
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
let previous_provider_state;
const overrides = [profile.provider.startsWith("http") ? `${profile.model} via ${profile.provider}` : `${profile.provider}/${profile.model}`];
state.providerStates[profile.provider] ??= {};
if (options.continue || options.cont) {
	previous_provider_state = state.providerStates[profile.provider].previous;
}
else if (options.amend) {
	previous_provider_state = state.providerStates[profile.provider].previous_previous;
}
const filesystemEnabled = options.fs !== false && !options.nofs;
initTools(filesystemEnabled, options.sandbox, options.web);
if (options.web) {
	overrides.push("web search enabled");
}
if (!filesystemEnabled) {
	overrides.push("no filesystem access");
}
if (options.sandbox) {
	overrides.push("sandbox enabled");
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

console.log((previous_provider_state ? "FOLLOW-UP" : "PROMPT") + ": " + prompt);
if (stdinText) {
	overrides.push("stdin provided");
	prompt = `${stdinText}\n\n${prompt}`;
}
console.log(`(${overrides.join(", ")})\n`);

//console.log({ model: profile.model, prompt, previous_provider_state });

const clientOpts = {
	apiKey: state.apiKeys[profile.provider],
};
let response;
if (profile.provider == "anthropic") {
	const client = new Anthropic(clientOpts);
	response = await anthropic_generateResponseOptionallyUsingTools(client, profile.model, prompt, previous_provider_state);
}
else {
	if (profile.provider != "openai") {
		clientOpts.baseURL = profile.provider;
		clientOpts.apiKey ||= "dummy";
	}
	const client = new OpenAI(clientOpts);
	response = await openai_generateResponseOptionallyUsingTools(client, profile.model, prompt, previous_provider_state);
}
state.providerStates[profile.provider].previous_previous = previous_provider_state;
state.providerStates[profile.provider].previous = response.state;
saveState();
if (response.used_tools) {
	if (used_docker) {
		execFileSync("docker", ["rm", "-f", "slave-sandbox"], { encoding: "utf8" });
	}
	console.log();
}
console.log(markdownToConsoleText(response.output_text) + "\n");
