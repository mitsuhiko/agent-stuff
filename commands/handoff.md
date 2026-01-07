Creates a detailed handoff plan of the conversation for continuing the work in a new session.

The user specified purpose:

<purpose>$ARGUMENTS</purpose>

You are creating a summary specifically so that it can be continued by another agent.  For this to work you MUST have a purpose.  If no specified purpose was provided in the `<purpose>...</purpose>` tag you must STOP IMMEDIATELY and ask the user what the purpose is.

Do not continue before asking for the purpose as you will otherwise not understand the instructions and do not assume a purpose!

## Goal

Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit purpose for the next steps.
This handoff plan should be thorough in capturing technical details, code patterns, and architectural decisions that will be essential for continuing development work without losing context.

## Process

Before providing your final plan, wrap your analysis in <analysis> tags to organize your thoughts and ensure you've covered all necessary points. In your analysis process:

1. Chronologically analyze each message and section of the conversation. For each section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts and code patterns
   - Specific details like file names, full code snippets, function signatures, file edits, etc
2. Double-check for technical accuracy and completeness, addressing each required element thoroughly.

Your plan should include the following sections:

1. **Primary Request and Intent**: Capture all of the user's explicit requests and intents in detail
2. **Key Technical Concepts**: List all important technical concepts, technologies, and frameworks discussed.
3. **Files and Code Sections**: Enumerate specific files and code sections examined, modified, or created. Pay special attention to the most recent messages and include full code snippets where applicable and include a summary of why this file read or edit is important.
4. **Problem Solving**: Document problems solved and any ongoing troubleshooting efforts.
5. **Pending Tasks**: Outline any pending tasks that you have explicitly been asked to work on.
6. **Current Work**: Describe in detail precisely what was being worked on immediately before this handoff request, paying special attention to the most recent messages from both user and assistant. Include file names and code snippets where applicable.
7. **Optional Next Step**: List the next step that you will take that is related to the most recent work you were doing. IMPORTANT: ensure that this step is DIRECTLY in line with the user's explicit requests, and the task you were working on immediately before this handoff request. If your last task was concluded, then only list next steps if they are explicitly in line with the users request. Do not start on tangential requests without confirming with the user first.

Additionally create a "slug" for this handoff.  The "slug" is how we will refer to it later in a few places.  Examples:

* current-user-api-handler
* implement-auth
* fix-issue-42

Together with the slug create a "Readable Summary".  Examples:

* Implement Current User API Handler
* Implement Authentication
* Fix Issue #42

## Output Structure

Here's an example of how your output should be structured:

```markdown
# Readable Summary

<analysis>
[Your thought process, ensuring all points are covered thoroughly and accurately]
</analysis>

<plan>
# Session Handoff Plan

## 1. Primary Request and Intent
[Detailed description of all user requests and intents]

## 2. Key Technical Concepts
- [Concept 1]
- [Concept 2]
- [...]

## 3. Files and Code Sections
### [File Name 1]
- **Why important**: [Summary of why this file is important]
- **Changes made**: [Summary of the changes made to this file, if any]
- **Code snippet**:
```language
[Important Code Snippet]
```

### [File Name 2]
- **Code snippet**:
```language
[Important Code Snippet]
```

[...]

## 4. Problem Solving
[Description of solved problems and ongoing troubleshooting]

## 5. Next Step
[Required next step to take, directly aligned with user's explicit handoff purpose]
</plan>
```

## Final Step

After providing your analysis and summary, write the handoff summary to a markdown file at `.claude/handoffs/[timestamp]-[slug].md` where [timestamp] is the current date in format YYYY-MM-DD and the slug is what we defined before.

Then tell the user about this file and that they can use `/pickup FILENAME` to continue.
