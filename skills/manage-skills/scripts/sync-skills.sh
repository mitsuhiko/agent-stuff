#!/bin/bash
set -euo pipefail
shopt -s nullglob

CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
SKILLS_DIR="$CLAUDE_CONFIG_DIR/skills"
SOURCES_FILE="$CLAUDE_CONFIG_DIR/skill-sources.txt"
DISABLED_FILE="$CLAUDE_CONFIG_DIR/disabled-skills.txt"
PINNED_FILE="$CLAUDE_CONFIG_DIR/pinned-skills.txt"

###################
# Safety Functions
###################

# Validate environment before any operations
validate_environment() {
  # HOME must be set and non-empty
  if [[ -z "${HOME:-}" ]]; then
    echo "Error: HOME environment variable not set"
    exit 1
  fi

  # SKILLS_DIR must be under HOME
  if [[ "$SKILLS_DIR" != "$HOME"/* ]]; then
    echo "Error: SKILLS_DIR must be under HOME directory"
    exit 1
  fi

  # Canonicalize SKILLS_DIR to prevent symlink bypass of prefix checks
  if [ -d "$SKILLS_DIR" ]; then
    SKILLS_DIR=$(cd "$SKILLS_DIR" && pwd -P)
  fi

  # SKILLS_DIR must be reasonably deep (at least $HOME/x/y)
  local depth
  depth=$(echo "$SKILLS_DIR" | tr -cd '/' | wc -c | tr -d ' ')
  if [[ $depth -lt 3 ]]; then
    echo "Error: SKILLS_DIR path too shallow: $SKILLS_DIR"
    exit 1
  fi
}

# Validate a source path is safe
validate_source_path() {
  local path="$1"

  # Must be absolute path
  if [[ "$path" != /* ]]; then
    echo "Error: source must be absolute path: $path"
    return 1
  fi

  # Reject root or near-root paths
  if [[ "$path" == "/" || "$path" == "//" ]]; then
    echo "Error: root path not allowed as source"
    return 1
  fi

  # Must be reasonably long (avoid /tmp, /var, etc.)
  if [[ ${#path} -lt 10 ]]; then
    echo "Error: source path suspiciously short: $path"
    return 1
  fi

  # Must be under HOME or common dev paths
  if [[ "$path" != "$HOME"/* && "$path" != /Users/* && "$path" != /home/* ]]; then
    echo "Error: source path outside home directory: $path"
    return 1
  fi

  return 0
}

# Validate a skill name is safe
validate_skill_name() {
  local name="$1"

  # Must be non-empty
  [[ -z "$name" ]] && return 1

  # No path traversal
  [[ "$name" == "." || "$name" == ".." ]] && return 1

  # No slashes (directory traversal)
  [[ "$name" == */* ]] && return 1

  # No leading dash (flag injection)
  [[ "$name" == -* ]] && return 1

  # Only allow alphanumeric, hyphens, underscores
  [[ ! "$name" =~ ^[a-zA-Z0-9_-]+$ ]] && return 1

  # Reasonable length
  [[ ${#name} -gt 100 ]] && return 1

  return 0
}

# Safe removal of symlinks - only removes if under SKILLS_DIR and is a symlink
safe_rm_symlink() {
  local target="$1"

  # Must be under SKILLS_DIR
  if [[ "$target" != "$SKILLS_DIR"/* ]]; then
    echo "Error: refusing to remove outside SKILLS_DIR: $target"
    return 1
  fi

  # Must be a symlink
  if [[ ! -L "$target" ]]; then
    echo "Error: not a symlink, refusing to remove: $target"
    return 1
  fi

  # Use -- to prevent flag injection from filenames starting with -
  rm -- "$target"
}

###################
# Config Loading
###################

# Load sources from config
load_sources() {
  SOURCES=()
  [ -f "$SOURCES_FILE" ] || { echo "Error: $SOURCES_FILE not found"; exit 1; }
  while IFS= read -r line; do
    { [[ "$line" =~ ^# ]] || [[ -z "$line" ]]; } && continue
    # Expand ~ to $HOME
    local expanded="${line/#\~/$HOME}"

    # Validate before adding
    if validate_source_path "$expanded"; then
      SOURCES+=("$expanded")
    fi
  done < "$SOURCES_FILE"

  if [[ ${#SOURCES[@]} -eq 0 ]]; then
    echo "Error: no valid sources found in $SOURCES_FILE"
    exit 1
  fi
}

# Load disabled skills
load_disabled() {
  disabled=()
  [ -f "$DISABLED_FILE" ] || return 0
  while IFS= read -r line; do
    { [[ "$line" =~ ^# ]] || [[ -z "$line" ]]; } && continue
    if validate_skill_name "$line"; then
      disabled+=("$line")
    else
      echo "Warning: invalid skill name in disabled list, skipping: $line"
    fi
  done < "$DISABLED_FILE"
}

# Load pinned skills (stored as "name|path" entries in pinned_entries array)
load_pinned() {
  pinned_entries=()
  [ -f "$PINNED_FILE" ] || return 0
  while IFS= read -r line; do
    { [[ "$line" =~ ^# ]] || [[ -z "$line" ]]; } && continue
    local name path
    name=$(echo "$line" | awk '{print $1}')
    path=$(echo "$line" | awk '{print $2}')

    if ! validate_skill_name "$name"; then
      echo "Warning: invalid skill name in pinned list, skipping: $name"
      continue
    fi

    local expanded="${path/#\~/$HOME}"
    if ! validate_source_path "$expanded"; then
      echo "Warning: invalid path in pinned list, skipping: $path"
      continue
    fi

    pinned_entries+=("$name|$expanded")
  done < "$PINNED_FILE"
}

# Get pinned path for a skill (returns empty if not pinned)
get_pinned_path() {
  local name="$1"
  for entry in "${pinned_entries[@]:-}"; do
    local pname="${entry%%|*}"
    local ppath="${entry#*|}"
    if [ "$pname" = "$name" ]; then
      echo "$ppath"
      return 0
    fi
  done
  return 1
}

# Check if skill is pinned
is_pinned() {
  local name="$1"
  get_pinned_path "$name" >/dev/null 2>&1
}

# Check if skill is disabled
is_disabled() {
  local name="$1"
  for dis in "${disabled[@]:-}"; do
    [ -z "$dis" ] && continue
    [ "$name" = "$dis" ] && return 0
  done
  return 1
}

# Get git root for a path
get_git_root() {
  git -C "$1" rev-parse --show-toplevel 2>/dev/null
}

# Get org/repo label for a source path
# Appends @branch when not on a default branch (main/master)
get_source_label() {
  local src="$1"
  local git_root
  git_root=$(get_git_root "$src") || { basename "$src"; return; }

  local url
  url=$(git -C "$git_root" remote get-url origin 2>/dev/null) || { basename "$git_root"; return; }

  # Parse org/repo from SSH or HTTPS URL
  local label
  if [[ "$url" =~ git@[^:]+:(.+)\.git$ ]]; then
    label="${BASH_REMATCH[1]}"
  elif [[ "$url" =~ https?://[^/]+/(.+?)(/?)\.git$ ]]; then
    label="${BASH_REMATCH[1]}"
  elif [[ "$url" =~ https?://[^/]+/(.+?)/?$ ]]; then
    label="${BASH_REMATCH[1]}"
  else
    label=$(basename "$git_root")
  fi

  # Append @branch when not on default branch
  local branch
  branch=$(git -C "$git_root" branch --show-current 2>/dev/null) || true
  if [[ -n "$branch" && "$branch" != "main" && "$branch" != "master" ]]; then
    label="${label}@${branch}"
  fi

  echo "$label"
}

# Parallel arrays for source labels (bash 3 compat, no declare -A)
SOURCE_LABEL_KEYS=()
SOURCE_LABEL_VALS=()

build_source_labels() {
  for src in "${SOURCES[@]}"; do
    SOURCE_LABEL_KEYS+=("$src")
    SOURCE_LABEL_VALS+=("$(get_source_label "$src")")
  done
}

# Lookup label for a source path
get_label_for_source() {
  local src="$1"
  local i
  for ((i=0; i<${#SOURCE_LABEL_KEYS[@]}; i++)); do
    if [ "${SOURCE_LABEL_KEYS[$i]}" = "$src" ]; then
      echo "${SOURCE_LABEL_VALS[$i]}"
      return
    fi
  done
  basename "$src"
}

# Prefetch all unique git roots in parallel (call once before check_freshness)
# Deduplicates by git root so each repo is fetched only once
prefetch_all_sources() {
  local fetched_roots=""
  local pids=()
  for src in "${SOURCES[@]}"; do
    [ -d "$src" ] || continue
    local git_root
    git_root=$(get_git_root "$src") || continue

    # Skip if already fetching this root
    case " $fetched_roots " in
      *" $git_root "*) continue ;;
    esac
    fetched_roots="$fetched_roots $git_root"

    # Fetch origin + upstream (if exists) in background
    (
      git -C "$git_root" fetch --quiet 2>/dev/null || true
      if git -C "$git_root" remote | grep -q '^upstream$'; then
        git -C "$git_root" fetch upstream --quiet 2>/dev/null || true
      fi
    ) &
    pids+=("$!")
  done

  # Wait for all fetches to complete
  for pid in "${pids[@]}"; do
    wait "$pid" 2>/dev/null || true
  done
}

# Check git freshness (assumes prefetch_all_sources already ran)
check_freshness() {
  local src="$1"
  local git_root
  git_root=$(get_git_root "$src") || { echo "not a git repo"; return; }

  local upstream behind
  upstream=$(git -C "$git_root" rev-parse --abbrev-ref "@{upstream}" 2>/dev/null) || { echo "no upstream"; return; }
  behind=$(git -C "$git_root" rev-list --count HEAD.."$upstream" 2>/dev/null) || { echo "unknown"; return; }

  if [ "$behind" -gt 0 ]; then
    echo "$behind behind"
  else
    echo "up to date"
  fi
}

# Check if upstream remote exists and has new commits (for forks)
# Assumes prefetch_all_sources already fetched upstream
check_upstream_remote() {
  local src="$1"
  local git_root
  git_root=$(get_git_root "$src") || return 1

  # Check if 'upstream' remote exists
  git -C "$git_root" remote | grep -q '^upstream$' || return 1

  # Check default branch on upstream (try main, then master)
  local upstream_branch=""
  if git -C "$git_root" rev-parse --verify upstream/main >/dev/null 2>&1; then
    upstream_branch="upstream/main"
  elif git -C "$git_root" rev-parse --verify upstream/master >/dev/null 2>&1; then
    upstream_branch="upstream/master"
  else
    return 1
  fi

  # Count commits ahead on upstream
  local ahead
  ahead=$(git -C "$git_root" rev-list --count HEAD.."$upstream_branch" 2>/dev/null) || return 1

  if [ "$ahead" -gt 0 ]; then
    echo "$ahead"
    return 0
  fi
  return 1
}

# Remove symlinks for disabled skills
cleanup_disabled() {
  local dry_run="${1:-false}"
  for dis in "${disabled[@]:-}"; do
    [ -z "$dis" ] && continue
    # Already validated in load_disabled, but double-check
    validate_skill_name "$dis" || continue

    local target="$SKILLS_DIR/$dis"
    if [ -L "$target" ]; then
      if [ "$dry_run" = true ]; then
        echo "Would disable: $dis"
      else
        if safe_rm_symlink "$target"; then
          echo "Disabled: $dis"
        fi
      fi
    fi
  done
}

# Sync pinned skills first
sync_pinned() {
  local dry_run="${1:-false}"
  for entry in "${pinned_entries[@]:-}"; do
    [ -z "$entry" ] && continue
    local name="${entry%%|*}"
    local src="${entry#*|}"

    # Already validated in load_pinned, but double-check
    validate_skill_name "$name" || continue

    local target="$SKILLS_DIR/$name"

    if is_disabled "$name"; then
      echo "Skipping pinned (disabled): $name"
      continue
    fi

    if [ ! -d "$src" ]; then
      echo "Warning: pinned source not found: $name -> $src"
      continue
    fi

    # Remove existing symlink to replace with pinned
    if [ -L "$target" ]; then
      if [ "$dry_run" = true ]; then
        echo "Would link pinned: $name -> $src"
      else
        safe_rm_symlink "$target" || continue
        ln -s -- "$src" "$target"
        echo "Linked pinned: $name"
      fi
    elif [ ! -e "$target" ]; then
      if [ "$dry_run" = true ]; then
        echo "Would link pinned: $name -> $src"
      else
        ln -s -- "$src" "$target"
        echo "Linked pinned: $name"
      fi
    else
      echo "Override exists: $name (keeping manual version over pin)"
    fi
  done
}

# Shadow tracking (parallel arrays, bash 3 compat)
SHADOW_NAMES=()    # skill names that are shadowed
SHADOW_OWNERS=()   # winning label for each
SHADOW_LOSERS=()   # comma-separated losing labels

# Record a shadow: first call sets owner, subsequent calls add losers
record_shadow() {
  local name="$1" label="$2" is_owner="${3:-false}"
  local i
  for ((i=0; i<${#SHADOW_NAMES[@]}; i++)); do
    if [ "${SHADOW_NAMES[i]}" = "$name" ]; then
      if [ "$is_owner" = true ]; then
        SHADOW_OWNERS[i]="$label"
      else
        if [ -n "${SHADOW_LOSERS[i]}" ]; then
          SHADOW_LOSERS[i]="${SHADOW_LOSERS[i]}, $label"
        else
          SHADOW_LOSERS[i]="$label"
        fi
      fi
      return
    fi
  done
  # New entry
  SHADOW_NAMES+=("$name")
  if [ "$is_owner" = true ]; then
    SHADOW_OWNERS+=("$label")
    SHADOW_LOSERS+=("")
  else
    SHADOW_OWNERS+=("")
    SHADOW_LOSERS+=("$label")
  fi
}

# Scan all sources and populate SHADOW_* arrays (for status/dry-run)
scan_shadows() {
  SHADOW_NAMES=()
  SHADOW_OWNERS=()
  SHADOW_LOSERS=()
  local seen_skills=""
  for src in "${SOURCES[@]}"; do
    [ -d "$src" ] || continue
    local label
    label=$(get_label_for_source "$src")
    for skill in "$src"/*; do
      [ -d "$skill" ] || continue
      [ -f "$skill/SKILL.md" ] || continue
      local name
      name=$(basename "$skill")
      validate_skill_name "$name" || continue
      is_disabled "$name" && continue
      is_pinned "$name" && continue
      case " $seen_skills " in
        *" $name "*)
          record_shadow "$name" "$label" false
          continue
          ;;
      esac
      seen_skills="$seen_skills $name"
      record_shadow "$name" "$label" true
    done
  done
}

# Count shadows from populated SHADOW_* arrays
count_shadow_entries() {
  local count=0 i
  for ((i=0; i<${#SHADOW_NAMES[@]}; i++)); do
    [ -n "${SHADOW_LOSERS[$i]}" ] && ((count++)) || true
  done
  echo "$count"
}

# Print shadow report from populated SHADOW_* arrays
print_shadows() {
  local shadow_count
  shadow_count=$(count_shadow_entries)
  if [[ $shadow_count -gt 0 ]]; then
    echo ""
    echo "Shadows ($shadow_count skills exist in multiple sources):"
    local i
    for ((i=0; i<${#SHADOW_NAMES[@]}; i++)); do
      local sname="${SHADOW_NAMES[$i]}"
      local owner="${SHADOW_OWNERS[$i]}"
      local losers="${SHADOW_LOSERS[$i]}"
      if [ -n "$losers" ]; then
        echo "  $sname: using $owner, also in $losers"
      fi
    done
  fi
}

# Main link logic
do_link() {
  local dry_run="${1:-false}"

  mkdir -p "$SKILLS_DIR"

  # Cleanup disabled skills first (before we snapshot)
  cleanup_disabled "$dry_run"

  # Snapshot existing links to detect what's new/changed, then remove all
  # NOTE: Space-delimited string is safe because skill names are restricted to
  # [a-zA-Z0-9_-]+ and source paths very rarely contain spaces.
  local existing_links=""
  for link in "$SKILLS_DIR"/*; do
    [ -L "$link" ] || continue
    local name target
    name=$(basename "$link")
    target=$(readlink "$link")
    # Skip broken symlinks (stale)
    if [ ! -e "$link" ]; then
      if [ "$dry_run" = false ]; then
        safe_rm_symlink "$link" && echo "Removed stale: $name"
      fi
      continue
    fi
    existing_links="$existing_links $name:$target"
    if [ "$dry_run" = false ]; then
      safe_rm_symlink "$link"
    fi
  done

  # In dry-run mode, we only preview — don't remove or recreate links
  if [ "$dry_run" = true ]; then
    sync_pinned "$dry_run"

    local seen_skills=""
    local would_link_count=0
    SHADOW_NAMES=()
    SHADOW_OWNERS=()
    SHADOW_LOSERS=()
    for src in "${SOURCES[@]}"; do
      [ -d "$src" ] || continue
      local label
      label=$(get_label_for_source "$src")
      for skill in "$src"/*; do
        [ -d "$skill" ] || continue
        [ -f "$skill/SKILL.md" ] || continue
        local name
        name=$(basename "$skill")
        validate_skill_name "$name" || continue
        is_disabled "$name" && continue
        is_pinned "$name" && continue
        case " $seen_skills " in
          *" $name "*)
            record_shadow "$name" "$label" false
            continue
            ;;
        esac
        seen_skills="$seen_skills $name"
        record_shadow "$name" "$label" true
        local target="$SKILLS_DIR/$name"
        if [ -d "$target" ] && [ ! -L "$target" ]; then
          echo "Override exists: $name (keeping manual version)"
        else
          echo "Would link: $name -> $skill"
          ((would_link_count++)) || true
        fi
      done
    done
    echo "Would sync: $would_link_count skills"
    print_shadows
    return
  fi

  # Sync pinned skills (highest priority)
  sync_pinned "$dry_run"

  # Track seen skills for shadow detection (space-separated list)
  local seen_skills=""
  local new_count=0 changed_count=0
  SHADOW_NAMES=()
  SHADOW_OWNERS=()
  SHADOW_LOSERS=()

  # Sync from sources
  for src in "${SOURCES[@]}"; do
    if [ ! -d "$src" ]; then
      echo "Warning: source not found: $src"
      continue
    fi

    local label
    label=$(get_label_for_source "$src")

    for skill in "$src"/*; do
      [ -d "$skill" ] || continue
      [ -f "$skill/SKILL.md" ] || continue

      local name
      name=$(basename "$skill")

      # Validate skill name
      if ! validate_skill_name "$name"; then
        echo "Warning: invalid skill name, skipping: $name"
        continue
      fi

      local target="$SKILLS_DIR/$name"

      # Skip if disabled
      if is_disabled "$name"; then
        continue
      fi

      # Skip if pinned (already handled)
      if is_pinned "$name"; then
        continue
      fi

      # Check if we've seen this skill before (first source wins)
      case " $seen_skills " in
        *" $name "*)
          # Shadow: skill exists in multiple sources
          record_shadow "$name" "$label" false
          continue
          ;;
      esac

      # Handle manual overrides (real directories, not symlinks)
      if [ -d "$target" ] && [ ! -L "$target" ]; then
        echo "Override exists: $name (keeping manual version)"
        seen_skills="$seen_skills $name"
        continue
      fi

      # Record as first seen and track owner for shadow reporting
      seen_skills="$seen_skills $name"
      record_shadow "$name" "$label" true

      ln -s -- "$skill" "$target"
      # Check if this is new or changed
      case "$existing_links" in
        *" $name:$skill"*) ;; # Same as before, no output
        *" $name:"*) echo "Linked: $name (changed)"; ((changed_count++)) || true ;;
        *) echo "Linked: $name"; ((new_count++)) || true ;;
      esac
    done
  done

  # Summary
  local total
  total=$(find "$SKILLS_DIR" -maxdepth 1 \( -type l -o -type d \) | wc -l)
  local summary="Done: $((total - 1)) skills"
  if [ "$new_count" -gt 0 ] || [ "$changed_count" -gt 0 ]; then
    summary="$summary ("
    [ "$new_count" -gt 0 ] && summary="${summary}${new_count} new"
    [ "$new_count" -gt 0 ] && [ "$changed_count" -gt 0 ] && summary="$summary, "
    [ "$changed_count" -gt 0 ] && summary="${summary}${changed_count} changed"
    summary="$summary)"
  fi
  echo "$summary"

  print_shadows

  if [ "$dry_run" = false ]; then
    echo ""
    echo "⚠️  Restart session to load skill changes (skills cached at startup)"
  fi
}



# Detect sources from same repo (returns count of repos with multiple entries)
detect_duplicate_repos() {
  local seen_roots="" duplicates=""
  for src in "${SOURCES[@]}"; do
    [ -d "$src" ] || continue
    local git_root
    git_root=$(get_git_root "$src") || continue

    case " $seen_roots " in
      *" $git_root "*)
        # Already seen this root
        case " $duplicates " in
          *" $git_root "*) ;; # Already counted
          *) duplicates="$duplicates $git_root" ;;
        esac
        ;;
      *) seen_roots="$seen_roots $git_root" ;;
    esac
  done
  echo "$duplicates"
}

# Status command
do_status() {
  local dry_run="${1:-false}"
  
  # Skip expensive prefetch in dry-run mode
  if [ "$dry_run" = false ]; then
    # Fetch all repos in parallel first (deduped by git root)
    prefetch_all_sources
  fi

  echo "Sources (by priority):"
  local priority=1

  # Build list of git roots with multiple entries for annotation
  local dup_repos
  dup_repos=$(detect_duplicate_repos)

  for src in "${SOURCES[@]}"; do
    local label
    label=$(get_label_for_source "$src")
    if [ ! -d "$src" ]; then
      printf "  [%d] ✗ %s (not found)\n" "$priority" "$label"
      ((priority++))
      continue
    fi

    # Check if this source's repo has multiple entries
    local git_root dup_marker=""
    git_root=$(get_git_root "$src") || git_root=""
    if [[ -n "$git_root" ]]; then
      case " $dup_repos " in
        *" $git_root "*) dup_marker=" [multi-path]" ;;
      esac
    fi

    local freshness
    freshness=$(check_freshness "$src")

    # Check for upstream remote (fork scenario)
    local upstream_info=""
    local upstream_ahead
    if upstream_ahead=$(check_upstream_remote "$src"); then
      upstream_info=" [upstream: $upstream_ahead new]"
    fi

    if [[ "$freshness" == "up to date" ]]; then
      printf "  [%d] ✓ %s (%s)%s%s\n" "$priority" "$label" "$freshness" "$dup_marker" "$upstream_info"
    elif [[ "$freshness" =~ behind ]]; then
      printf "  [%d] ⚠ %s (%s)%s%s\n" "$priority" "$label" "$freshness" "$dup_marker" "$upstream_info"
    else
      printf "  [%d] ? %s (%s)%s%s\n" "$priority" "$label" "$freshness" "$dup_marker" "$upstream_info"
    fi
    ((priority++))
  done

  echo ""
  echo "Skills:"
  local linked=0 disabled_count=0 pinned_count=0 stale=0 manual=0

  for item in "$SKILLS_DIR"/*; do
    [ -e "$item" ] || [ -L "$item" ] || continue
    local name
    name=$(basename "$item")

    if [ -L "$item" ] && [ ! -e "$item" ]; then
      ((stale++))
    elif [ -L "$item" ]; then
      ((linked++))
    elif [ -d "$item" ]; then
      ((manual++))
    fi
  done

  pinned_count=${#pinned_entries[@]}
  disabled_count=${#disabled[@]}
  scan_shadows
  local shadow_count
  shadow_count=$(count_shadow_entries)

  echo "  $linked linked, $manual manual, $pinned_count pinned, $disabled_count disabled, $stale stale, $shadow_count shadowed"

  # Warn about multi-path repos (reuse dup_repos from above)
  if [[ -n "$dup_repos" ]]; then
    local dup_count
    dup_count=$(echo "$dup_repos" | wc -w | tr -d ' ')
    echo ""
    echo "⚠️  $dup_count repo(s) have multiple paths in skill-sources.txt (marked [multi-path] above)"
    echo "   This is fine if they contain different skills, but may indicate config duplication."
  fi
}

# Get label for a skill's symlink target
get_skill_label() {
  local src="$1"
  local i
  for ((i=0; i<${#SOURCE_LABEL_KEYS[@]}; i++)); do
    if [[ "$src" == "${SOURCE_LABEL_KEYS[$i]}"/* ]]; then
      echo "${SOURCE_LABEL_VALS[$i]}"
      return
    fi
  done
  echo "$src"
}

# Get shadow labels for a skill name (sources after the first that also have it)
get_shadow_labels() {
  local name="$1"
  local shadow_labels=""
  local found_first=false
  local i
  for ((i=0; i<${#SOURCES[@]}; i++)); do
    local src="${SOURCES[$i]}"
    [ -d "$src" ] || continue
    if [ -d "$src/$name" ] && [ -f "$src/$name/SKILL.md" ]; then
      if [ "$found_first" = false ]; then
        found_first=true
        continue
      fi
      local label="${SOURCE_LABEL_VALS[$i]}"
      if [ -n "$shadow_labels" ]; then
        shadow_labels="$shadow_labels, $label"
      else
        shadow_labels="$label"
      fi
    fi
  done
  echo "$shadow_labels"
}

# List command
do_list() {
  echo "Skills:"
  for item in "$SKILLS_DIR"/*; do
    [ -e "$item" ] || [ -L "$item" ] || continue
    local name
    name=$(basename "$item")

    if [ -L "$item" ] && [ ! -e "$item" ]; then
      printf "  %-30s (stale - source missing)\n" "$name"
    elif [ -L "$item" ]; then
      local src
      src=$(readlink "$item")
      local label
      label=$(get_skill_label "$src")
      local suffix=""
      is_pinned "$name" && suffix=" [pinned]"
      printf "  %-30s %s%s\n" "$name" "$label" "$suffix"

      # Show shadows
      if ! is_pinned "$name" && ! is_disabled "$name"; then
        local shadow_info
        shadow_info=$(get_shadow_labels "$name")
        if [[ -n "$shadow_info" ]]; then
          printf "  %-30s  (shadows: %s)\n" "" "$shadow_info"
        fi
      fi
    elif [ -d "$item" ]; then
      printf "  %-30s (manual override)\n" "$name"
    fi
  done

  if [ ${#disabled[@]} -gt 0 ]; then
    echo ""
    echo "Disabled:"
    for dis in "${disabled[@]}"; do
      echo "  $dis"
    done
  fi
}

# Pull command
do_pull() {
  local dry_run="${1:-false}"
  echo "Pulling sources..."

  local updated_roots=()
  for src in "${SOURCES[@]}"; do
    [ -d "$src" ] || continue

    local git_root
    git_root=$(get_git_root "$src") || continue

    # Skip if already updated this root
    for updated in "${updated_roots[@]:-}"; do
      [ "$updated" = "$git_root" ] && continue 2
    done
    updated_roots+=("$git_root")

    if [ "$dry_run" = true ]; then
      echo "Would pull: $git_root"
    else
      echo "Updating: $git_root"
      # pipefail (set globally) ensures the if-test reflects git's exit code, not sed's
      if git -C "$git_root" pull --ff-only 2>&1 | sed 's/^/  /'; then
        :
      else
        echo "  Failed: may need manual intervention"
      fi
    fi
  done

  echo ""
  do_link "$dry_run"
}

# Main
validate_environment
load_sources
build_source_labels
load_disabled
load_pinned

# Parse --dry-run flag from any position
DRY_RUN=false
COMMAND=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    *) COMMAND="$arg" ;;
  esac
done

case "${COMMAND}" in
  link)
    do_link "$DRY_RUN"
    ;;
  status)
    do_status "$DRY_RUN"
    ;;
  list)
    do_list
    ;;
  pull)
    do_pull "$DRY_RUN"
    ;;
  *)
    echo "Usage: sync-skills.sh <command> [--dry-run]"
    echo ""
    echo "Commands:"
    echo "  link       Symlink skills from sources"
    echo "  status     Show source freshness, conflicts, disabled, stale"
    echo "  pull       Git pull all sources, then link"
    echo "  list       Show all skills with their source paths"
    echo ""
    echo "Flags:"
    echo "  --dry-run  Preview changes without making them (use with link, status, or pull)"
    exit 1
    ;;
esac
