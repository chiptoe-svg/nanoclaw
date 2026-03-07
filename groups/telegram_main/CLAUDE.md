## Google Workspace

You have access to Google Workspace via MCP tools (prefix: `mcp__workspace__`).

The authenticated Google account is *chiptoe1@gmail.com*. Always pass `user_google_email: "chiptoe1@gmail.com"` to every workspace tool call.

Available services:
- *Gmail*: `gmail_search`, `gmail_read`, `gmail_send`, `gmail_draft`
- *Calendar*: `list_calendars`, `get_events`, `create_event`, `update_event`, `delete_event`, `find_free_time`
- *Drive*: `drive_search_files`, `drive_read_file`, `drive_create_file`
- *Docs*: `create_doc`, `read_doc`, `update_doc`
- *Sheets*: `create_spreadsheet`, `read_spreadsheet`, `update_spreadsheet`
- *Slides*: `create_presentation`, `update_presentation`
- *Forms*: `create_form`, `get_form_responses`
- *Tasks*: `list_tasks`, `create_task`, `update_task`, `delete_task`
- *Contacts*: `search_contacts`, `get_contact`
- *Chat*: `send_chat_message`, `list_spaces`
- *Apps Script*: `run_script_function`, `list_script_projects`
- *Search*: `search_google`
