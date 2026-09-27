## Speech to Text Capabilities

- Add the new speech to text capability (transcription) and automatically pull it from the providers, where available
- Add a new model mapping for speech to text. It should offer:
  - By default the browser based Speech to Text features (which use a remote server)
  - Additionally, list all models that offer the new capability
- Reimplement the speech to text mic icon that is available on the chat pages and have it use the new setting. So either route transcription via API to the respective model or use the browser functionality.
- Add this to the OpenAI Compatible API endpoints, to that Users can access this via their API keys as well.

## Text to Speech Capabilities

- Add a new text to speech capability (Speech)
- Add a new model mapping for it, which by default is empty and should error, if no model is assigned on usage
- For now just add a smaller loudspeaker button to the AI replies that should then read out the text to the user. In the future we will probably implement a proper voice only chat mode.
- Add this to the OpenAI Compatible API endpoints, to that Users can access this via their API keys as well.

## Decision model

- Since Jev has been released, this would also be super useful to have this kind of model be exposed via the API.
- Add a new capability decision to the models page and pull it from the providers where available.
- Add a new model mapping for it, which by default is empty and should error, if no model is assigned on usage
- Add this to the OpenAI Compatible API endpoints, to that Users can access this via their API keys as well.
- Add a new mcp server, which can be used to perform decisions by AI agents.

## LM Studio Context Length parsing

- For LM Studio providers, support pulling in the configured context length
