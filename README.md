# slave

Vibe coding without the kaboom factor.

## Installation

```
npm i -g @calamity-inc/slave
```

## Usage

In any directory:
```
slave [flags] [--] How do I use the 'slave' command?
```

You can also pipe text in:
```
cat yap.txt | slave Summarize this text
```

Flags:
- `-c`, `--cont`, `--continue` — add your previous invocation to the context of this one
- `-w`, `--web` — allow the model to search the web
- `-n`, `--no-fs`, `--nofs` — disables filesystem access so you can just have a non-binding chat with the model

Single-character flags can be combined, so `slave -cw prompt` is equivalent to `slave -c -w prompt`.

## Sandboxing / Security

The model gets no command prompt access and limited access to your filesystem:
- Only within the working directory and subdirectories.
- `.git` folder and `.env` file can't be accessed by the model, tho it knows they exist, if they do.
- Files that are `.gitignore`d can't be written to.

However, these restrictions are only as good as your practices; you should:
- Only run `slave` in Git-tracked folders and be sure that anything you don't want to lose is committed or at least staged so you can always revert any changes made by the model.
- Review changes to your code before running anything, including tests.
