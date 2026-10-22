#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import OpenAI from "openai";

const env = parseEnv(fs.readFileSync(".env", "utf8"));
const client = new OpenAI({
	apiKey: env.OPENAI_API_KEY,
});

const isOutOfReach = (p) => {
	if (p.indexOf(".env") != -1 || path.resolve(p).split(path.sep).includes(".git")) {
		return true;
	}
	const rel = path.relative(".", p);
	return rel.startsWith("..") || path.isAbsolute(rel);
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

const generateResponseOptionallyUsingTools = async (input) => {
	const model = "gpt-6-luna";
	let response = await client.responses.create({
		model,
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

	return response.output_text;
};

if (process.argv.length <= 2) {
	console.log("Syntax: slave <prompt>");
	process.exit(1);
}
const prompt = process.argv.slice(2).join(" ");
console.log("PROMPT: " + prompt + "\n");
const response = await generateResponseOptionallyUsingTools(prompt);
console.log("\n" + response + "\n");
