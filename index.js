#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { createInterface } from "node:readline/promises";
import ignore from "ignore";
import { marked } from "marked";
import { markedTerminal } from "marked-terminal";
import OpenAI from "openai";

const configDir = path.dirname(fileURLToPath(import.meta.url));
const env = fs.existsSync(path.join(configDir, ".env")) ? parseEnv(fs.readFileSync(path.join(configDir, ".env"), "utf8")) : {};
if (!env.OPENAI_API_KEY) {
	if (!process.stdin.isTTY) {
		console.error(`No OPENAI_API_KEY found. Run this command in a terminal to enter your key, or add it to ${path.join(configDir, ".env")}.`);
		process.exit(1);
	}

	const readline = createInterface({ input: process.stdin, output: process.stdout });
	try {
		env.OPENAI_API_KEY = (await readline.question("Enter your OpenAI API key: ")).trim();
	}
	finally {
		readline.close();
	}
	if (!env.OPENAI_API_KEY) {
		console.error("An API key is required.");
		process.exit(1);
	}
	console.log();

	fs.writeFileSync(path.join(configDir, ".env"), `OPENAI_API_KEY=${env.OPENAI_API_KEY}`, { encoding: "utf8", mode: 0o600 });
	fs.chmodSync(path.join(configDir, ".env"), 0o600);
}
const client = new OpenAI({
	apiKey: env.OPENAI_API_KEY,
});

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
	if (type == "write" && rel && gitignore.ignores(rel)) {
		return true;
	}
	return false;
};

const readFileForModel = (filePath) => fs.readFileSync(filePath, "utf8").replaceAll("\r\n", "\n");
const writeFileFromModel = (filePath, data, usesCRLF) => {
	if (usesCRLF === undefined) {
		usesCRLF = fs.existsSync(filePath) && fs.readFileSync(filePath, "utf8").includes("\r\n");
	}
	const normalized = data.replaceAll("\r\n", "\n");
	fs.writeFileSync(filePath, usesCRLF ? normalized.replaceAll("\n", "\r\n") : normalized, "utf8");
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
			return "Out of your reach";
		}
		return readFileForModel(path);
	},
	writeFile: ({ path, data }) => {
		if (isOutOfReach(path, "write")) {
			return "Out of your reach";
		}
		writeFileFromModel(path, data);
		return "OK";
	},
	fileFindAndReplace: ({ path, substring, replacement, expectedMatches }) => {
		if (isOutOfReach(path, "write")) {
			return "Out of your reach";
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
	system: ({ command }) => {
		//process.exit(1);
		return "It's interesting that you called this tool! Unfortunately for you, it does nothing.";
	},
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

const generateResponseOptionallyUsingTools = async (input, previous_response_id) => {
	const model = "gpt-6-luna";
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
	const text = marked.parse(md);
	console.error = _console_error;
	return text;
};

let i = 2;
let previous_response_id;
const overrides = [];
const processFlag = (flag) => {
	if (flag == "-c" || flag == "--cont" || flag == "--continue") {
		if (fs.existsSync(path.join(configDir, ".state.json"))) {
			previous_response_id = JSON.parse(fs.readFileSync(path.join(configDir, ".state.json"), "utf8")).previous_response_id;
		}
	}
	else if (flag == "-w" || flag == "--web") {
		if (!overrides.includes("web search enabled")) {
			tools.push({ type: "web_search" });
			overrides.push("web search enabled");
		}
	}
	else if (flag == "-n" || flag == "--no-fs" || flag == "--nofs") {
		if (!overrides.includes("no filesystem access")) {
			tools = tools.filter(tool => tool.type != "function");
			overrides.push("no filesystem access");
		}
	}
	else {
		console.log(`Unknown flag: ${flag}`);
	}
};
for (; i != process.argv.length; ++i) {
	const argument = process.argv[i];
	if (!argument.startsWith("-")) {
		break;
	}
	if (argument == "--") {
		++i;
		break;
	}
	// Short flags can be combined (for example, -cw is equivalent to -c -w).
	const flags = argument.startsWith("--") || argument.length <= 2
		? [argument]
		: [...argument.slice(1)].map((flag) => `-${flag}`);
	for (const flag of flags) {
		processFlag(flag);
	}
}
let prompt = process.argv.slice(i).join(" ").trim();
let stdinText = "";
if (!process.stdin.isTTY) {
	const chunks = [];
	for await (const chunk of process.stdin) {
		chunks.push(chunk);
	}
	stdinText = Buffer.concat(chunks).toString("utf8");
}
if (!prompt) {
	console.log("Syntax: slave [flags] [--] <prompt>");
	process.exit(1);
}

console.log((previous_response_id ? "FOLLOW-UP" : "PROMPT") + ": " + prompt);
if (stdinText) {
	overrides.push("stdin provided");
	prompt = `${stdinText}\n\n${prompt}`;
}
if (overrides.length) {
	console.log(`(${overrides.join(", ")})`);
}
console.log();
const response = await generateResponseOptionallyUsingTools(prompt, previous_response_id);
fs.writeFileSync(path.join(configDir, ".state.json"), JSON.stringify({ previous_response_id: response.id }), "utf8");
if (response.used_tools) {
	console.log();
}
console.log(markdownToConsoleText(response.output_text).trimEnd() + "\n");
