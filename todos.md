npx shadcn@latest apply --preset bKsE3ZC6

General Questions:

Todos:

- Email integration (gmail)
- Calendar integration (apple)

- switch all sync fs method calls to their async counterparts
- Improve startup times, sometimes it feels a bit slower

Next Steps:

- Code review pass
- Security hardening pass
- M8 Deep research

- Telegram/Discord Integration?

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
- Add this to the OpenAI Compatible API endpoints, to that Users can access this via their API keys as well:
  https://developers.openai.com/api/docs/guides/decisions
  https://developers.openai.com/api/reference/resources/decisions/methods/create
- Add a new mcp server, which can be used to perform decisions by AI agents.

## LM Studio Context Length parsing

- For LM Studio providers, support pulling in the configured context length

## Coding Agents
- Workspaces with one isolated environment per agent or task
- Repository integration with GitHub, Gitea, GitLab, or Bitbucket (using url of the service + PAT)
- Should leverage opencode as a harness and be auto configured to run against the proxy that is part of the app
- Should be configurable in the settings as to which model to use
- Conversations of the agent should show up as regular conversations in the ui.
- To kick off a coding agent, make this selectable durting chat drafting, where I can pick a git project/workspace from the available repos or use a blank project (i.e. new or similar).
- Ideally the coding agent does it's thing, tests, validates and once complete creates a pr for the functionality. When it needs my input it should say sow and the chat should indicate this.
- It should create a pr on a dedicated branch, which I can then review.
- What would be super usefrul for web based apps, is the option to open the current environment as a preview, so I can test features directly in the browser, without having to run things locally


On the pr creation, i am not fully behind the create pr thingy, is it just the rest api creating the pr for the already pushed branch? Also we probably do need an api to get the current status of a pr, check if it exists, read any comments, ... How do we do that?
