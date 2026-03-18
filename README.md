# Sprint Story Generator — Setup Guide

## What is this?
An AI-powered app that runs inside Claude. Enter your sprint tasks → it generates structured user stories with descriptions, acceptance criteria, and SP estimates → push directly to Jira with proper field mapping.

## Features
- AI story generation with "As a Data Analyst..." format
- M365 enrichment (searches your Outlook, Teams, SharePoint for context)
- Per-task Priority, Parent (Epic), and Sprint selection
- Direct Jira push with field mapping: Description, Acceptance Criteria, Story Points, Priority, Parent, Sprint, Assignee
- Editable SP estimates before pushing

## Setup (one-time, ~2 minutes)

### Step 1: Enable Connectors in Claude
1. Go to claude.ai and log in
2. Click your profile icon → Settings → Connected Apps
3. Enable **Atlassian** — follow the prompts to authenticate with your Jira account
4. Enable **Microsoft 365** — follow the prompts to authenticate with your Microsoft account
5. Both connectors should show as "Connected"

### Step 2: Load the App
1. Start a new chat in Claude
2. Upload the `SprintStoryGenerator.jsx` file (drag and drop or use the attachment button)
3. Type: "Please render this as a React artifact"
4. Claude will render the Sprint Story Generator app in the artifact panel

### Step 3: Use It
1. Add your sprint tasks (one per row)
2. Set Priority per task, add Notes for context (click the notepad icon)
3. Toggle M365 enrichment on/off
4. Click "Generate Stories"
5. Review stories, edit SP by clicking the badge
6. Enter your Jira project key and click "Connect"
7. Select Parent (Epic) and Sprint per task from the dropdowns
8. Click "Push All to Jira"

## Notes
- Each person pushes stories as themselves — the app detects your Jira identity
- Story generation works without Jira connected — you just can't push until you connect
- Sprint cap is 8 SP by default — the AI tries to stay within this
- Custom field IDs are pre-configured for the Lilly Jira instance
