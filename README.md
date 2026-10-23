# slave

Vibe coding without the kaboom factor.

## Setup

1. Install slave: `npm i -g @calamity-inc/slave`
2. Create a default profile, e.g. `slave --create-profile default openai gpt-6-luna`

## Usage

In any directory:
```
slave [options] [--] How do I use the 'slave' command?
```

You can also pipe text in:
```
cat yap.txt | slave Summarize this text
```

Options:
- `-c`, `--cont`, `--continue` — add your previous invocation to the context of this one
- `-a`, `--amend` — retry the previous invocation, using the context from before it
- `-w`, `--web` — allow the model to search the web
- `-n`, `--no-fs`, `--nofs` — disable filesystem access
- `-s`, `--sandbox` — allow the model to use a docker container
- `-p, --profile <name>` — use the specified profile

Single-character flags can be combined, so `slave -cw prompt` is equivalent to `slave -c -w prompt`.

Subcommands:
- `--create-profile <name> <provider> <model>` — creates a profile
	- `provider` can be `openai` or an OpenAI-compatible base URL, e.g. `http://127.0.0.1:1234/v1` for [LM Studio](https://lmstudio.ai/developers).
- `--delete-profile <name>` — deletes a profile
- `--update-api-key <provider>` — updates an API Key

## Security

The model can't run commands on your system; it only gets limited access to your filesystem:
- Within the working directory and subdirectories.
- `.git` folder and `.env` file can't be accessed by the model, tho it knows they exist, if they do.
- Files that are `.gitignore`d can't be written to.
- You can provide a `.slaveignore` for files that the model should not be allowed to read or write. It will still be able to know of their existence.

However, these restrictions are only as good as your practices; you should:
- Only run `slave` in Git-tracked folders and be sure that anything you don't want to lose is committed or at least staged so you can always revert any changes made by the model.
- Review changes to your code before running anything, including tests.
