# slave

Vibe coding without the kaboom factor.

## Installation

I will publish to NPM later (maybe). For now, Git clone, `npm i -g .`, and Git pull for updates. ;)

## Usage

In any directory:
```
slave [flags] [--] How do I use the 'slave' command?
```

Flags:
- `-c`, `--cont`, `--continue` — add your previous invokation to the context of this one
- `-w`, `--web` — allow the model to search the web search

Single-character flags can be combined, so `slave -cw prompt` is equivalent to `slave -c -w prompt`.

## Sandboxing / Security

The model has read/write access to the working directory and any subdirectories of it, except for the `.git` folder and `.env` files.

This means that you should only run `slave` in Git-tracked folders, and be sure that anything you don't want to lose is committed or at least staged so you can always revert any changes made by the model.

No access is given to run any commands on your system, not even to run your tests (because tests are code that the model can change).
