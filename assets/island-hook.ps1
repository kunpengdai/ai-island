param([string]$Tool, [string]$Event)
# AI Island observer. No stdout, no control decisions, no transcript or tool input saved.
$ErrorActionPreference = 'SilentlyContinue'
try {
    [Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
    $raw = [Console]::In.ReadToEnd()
    if (-not $raw) { exit 0 }
    $payload = $raw | ConvertFrom-Json -ErrorAction Stop
    # Cursor can also load Claude-compatible hooks. Preserve the actual tool
    # identity so imported hooks do not create a second, fake Claude task.
    if ($payload.cursor_version -or $payload.conversation_id) {
        $Tool = 'cursor'
        $mapped = @{
            SessionStart = 'sessionStart'; UserPromptSubmit = 'beforeSubmitPrompt'
            PreToolUse = 'preToolUse'; PostToolUse = 'postToolUse'
            Stop = 'stop'; SessionEnd = 'sessionEnd'
        }
        if ($mapped.ContainsKey($Event)) { $Event = $mapped[$Event] }
    }
    $session = $payload.session_id
    if (-not $session) { $session = $payload.conversation_id }
    if (-not $session -and $Event -eq 'workspaceOpen') { $session = 'workspace:' + [string]($payload.workspace_roots -join '|') }
    if (-not $session) { exit 0 }
    $project = $payload.cwd
    if (-not $project -and $payload.workspace_roots) { $project = $payload.workspace_roots[0] }
    $title = [string]$payload.prompt
    if ($title.Length -gt 160) { $title = $title.Substring(0, 160) }
    $turn = $payload.turn_id
    if (-not $turn) { $turn = $payload.generation_id }
    $id = [Guid]::NewGuid().ToString('N')
    $item = @{
        id = $id; tool = $Tool; event = $Event; sessionId = [string]$session
        turnId = [string]$turn; timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        cwd = [string]$project; title = $title; model = [string]$payload.model
        toolName = [string]$payload.tool_name; result = [string]$payload.status
        notificationType = [string]$payload.notification_type
        orcaPaneKey = [string]$env:ORCA_PANE_KEY; orcaWorktreeId = [string]$env:ORCA_WORKTREE_ID
    }
    $root = $env:AGENT_ISLAND_EVENT_DIR
    if (-not $root) { $root = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'AgentIsland\events' }
    [IO.Directory]::CreateDirectory($root) | Out-Null
    $temp = Join-Path $root ($id + '.tmp')
    $dest = Join-Path $root ($id + '.json')
    [IO.File]::WriteAllText($temp, ($item | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
    [IO.File]::Move($temp, $dest)
} catch { }
exit 0
