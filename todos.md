npx shadcn@latest apply --preset bKsE3ZC6

General Questions:

- Check on model capabilities settings, currently they don't do anything, do they?

Todos:

- Also show file attachment picker on new conversation tab

- Promote to shared skill does work but you can't really see, the shared version/your version. 

- Add additional default provider types, such as: LM Studio, Openrouter, with prefilled url, maybe even icons in the ui?

- prices seem quite high in the requests tab
- Optimize mobile view:
  - Sidebar menu not taking up space inthe main chat window
  - Sidebar not expanded by default
  - Sidebar should cover full viewport (push regular content off screen)
  - Hide persona picker in general, when no persona is used in the chat interface

- Improved markdown/chat rendering (review chat http://localhost:5173/chat/76bc29fe-c5f1-4120-a30e-a3977585774d)
- switch all sync fs method calls to their async counterparts
- Improve startup times, sometimes it feels a bit slower
- Uploading photos to the AI from the phone (i.e. take a photo directly ideally)

Next Steps:

- Other enhancements
- Code review pass
- Security hardening pass
- M8 Deep research
- Code Execution for basic tasks in a sandbox?

Ideas for later

- For webfetch mcp, convert the html to .md first ad optional parameter
- Weather MCP, using open-meteo. wttr.in (no API key) we can use the openmeteo npm package for this
