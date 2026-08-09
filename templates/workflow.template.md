---
schema_version: 1
project_id: "<project-id>"
generated_at: "<timestamp>"
primary_type: "<primary-type>"
languages:
  - "<language>"
frameworks:
  - "<framework>"
build_systems:
  - "<build-system>"
test_frameworks:
  - "<test-framework>"
task_source_types:
  - "<task-source-type>"
review_required: true
activation: "manual"
workspace_strategy:
  mode: "worktree"
  branch_template: "{{task.id}}-{{slug}}"
  provision_command: null
  workspace_source_priority:
    - "project_primary"
    - "task_session_cwd"
    - "agent_home"
    - "default"
---

# Workflow

<summary>

## Workspace Strategy

- mode: `worktree`
- branch template: `{{task.id}}-{{slug}}`
- provision command: _none_
- workspace source priority: `project_primary`, `task_session_cwd`, `agent_home`, `default`

## Task Sources

- `<task-source-type>`

## Review Notes

- generated onboarding artifacts are reviewable and do not auto-activate new behavior
- sensitive values must be redacted, omitted, or stored through a secret reference
