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
	//{ type: "web_search" }, // TODO: Make it a toggle or so?
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

		// Send the results back so the model can formulate its answer.
		response = await client.responses.create({
			model,
			previous_response_id: response.id,
			input: outputs,
			tools,
		});
	}

	return response;
};

if (process.argv.length <= 2) {
	console.log("Syntax: slave <prompt>");
	process.exit(1);
}
let i = 2;
let previous_response_id;
for (; i != process.argv.length; ++i) {
	if (!process.argv[i].startsWith("-")) {
		break;
	}
	if (process.argv[i] == "--") {
		++i;
		break;
	}
	if (process.argv[i] == "-c" || process.argv[i] == "--cont" || process.argv[i] == "--continue") {
		if (fs.existsSync(path.join(configDir, ".state.json"))) {
			previous_response_id = JSON.parse(fs.readFileSync(path.join(configDir, ".state.json"), "utf8")).previous_response_id;
		}
	}
	else {
		console.log("Unknown flag: ")
	}
}
const prompt = process.argv.slice(i).join(" ");
console.log("PROMPT: " + prompt + "\n");
const response = await generateResponseOptionallyUsingTools(prompt, previous_response_id);
fs.writeFileSync(path.join(configDir, ".state.json"), JSON.stringify({ previous_response_id: response.id }), "utf8");
marked.use(markedTerminal());
console.log("\n" + marked.parse(response.output_text).trimEnd() + "\n");
