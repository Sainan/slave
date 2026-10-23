#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from 'node:url';
import { parseEnv } from "node:util";
import { marked } from "marked";
import { markedTerminal } from "marked-terminal";
import OpenAI from "openai";

const configDir = path.dirname(fileURLToPath(import.meta.url));
const env = parseEnv(fs.readFileSync(path.join(configDir, ".env"), "utf8"));
const client = new OpenAI({
	apiKey: env.OPENAI_API_KEY,
});

const isOutOfReach = (p) => {
	const rel = path.relative(".", p);
	if (rel.startsWith("..") || path.isAbsolute(rel)) {
		return true;
	}
	const segs = rel.split(path.sep);
	if (segs.includes(".env") || segs.includes(".git")) {
		return true;
	}
	return false;
};

const functions = {
	ls: ({ path }) => {
		path ??= ".";
		if (isOutOfReach(path)) {
			return "Out of your reach.";
		}
		return JSON.stringify(fs.readdirSync(path, { withFileTypes: true }).map(dirent => dirent.isDirectory() ? `${dirent.name}/` : dirent.name));
	},
	readFile: ({ path }) => {
		if (isOutOfReach(path)) {
			return "Out of your reach.";
		}
		return fs.readFileSync(path, "utf8");
	},
	writeFile: ({ path, data }) => {
		if (isOutOfReach(path)) {
			return "Out of your reach.";
		}
		fs.writeFileSync(path, data, "utf8");
		return "OK";
	},
	system: ({ command }) => {
		//process.exit(1);
		return "It's interesting that you called this tool! Unfortunately for you, it does nothing.";
	},
};

const tools = [
	{
		type: "function",
		name: "ls",
		description: "Lists files.",
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
	},
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
			//console.log("\t" + output.replaceAll("\r", "<CR>").replaceAll("\n", "<NL>"));
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

if (process.argv.length <= 2) {
	console.log("Syntax: slave <prompt>");
	process.exit(1);
}
let i = 2;
let previous_response_id;
let web;
const processFlag = (flag) => {
	if (flag == "-c" || flag == "--cont" || flag == "--continue") {
		if (fs.existsSync(path.join(configDir, ".state.json"))) {
			previous_response_id = JSON.parse(fs.readFileSync(path.join(configDir, ".state.json"), "utf8")).previous_response_id;
		}
	}
	else if (flag == "-w" || flag == "--web") {
		tools.push({ type: "web_search" });
		web = true;
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
const prompt = process.argv.slice(i).join(" ");
console.log((previous_response_id ? "FOLLOW-UP" : "PROMPT") + ": " + prompt);
if (web) {
	console.log("(web_search enabled)");
}
console.log();
const response = await generateResponseOptionallyUsingTools(prompt, previous_response_id);
fs.writeFileSync(path.join(configDir, ".state.json"), JSON.stringify({ previous_response_id: response.id }), "utf8");
if (response.used_tools) {
	console.log();
}
console.log(markdownToConsoleText(response.output_text).trimEnd() + "\n");
