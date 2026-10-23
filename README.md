# slave

Vibe coding without the kaboom factor.

## Installation

I will publish to NPM later (maybe). For now, Git clone, `npm i -g .`, and Git pull for updates. ;)

## Configuration

Create a file named `.env` in the slave clone directory, with your OpenAI API key:

```env
OPENAI_API_KEY=your_openai_api_key
```

## Usage

In any directory:
```
slave [flags] [--] How do I use the 'slave' command?
```

Flags:
- `-c`, `--cont`, `--continue` — add your previous invokation to the context of this one
- `-w`, `--web` — allow the model to search the web search

Single-character flags can be combined, so `slave -cw prompt` is equivalent to `slave -c -w prompt`.
