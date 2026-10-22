# slave

Vibe coding without the kaboom factor.

## Installation

I will publish to NPM later (maybe). For now, Git clone, `npm i -g .`, and Git pull for updates. ;)

## Configuration

Create a file named `.env` in the directory you will run `slave` from, with your OpenAI API key:

```env
OPENAI_API_KEY=your_openai_api_key
```

The program reads `.env` from the current working directory at startup and uses `OPENAI_API_KEY` to authenticate its OpenAI API requests. Replace the example value with your own key. Keep this file private: do not commit it or share it, since anyone with the key may be able to use your OpenAI account.
