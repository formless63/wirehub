#!/usr/bin/env bash
# privacy-check — keeps personal and secret material out of the repository.
#
# Modes (one per run):
#   --staged             the staged changes (the pre-commit hook)
#   --commit-msg <file>  a commit message (the commit-msg hook)
#   --range <a>..<b>     the commits in a range: their added lines, paths,
#                        author/committer emails and messages (CI)
#   --tree               every tracked and untracked (not ignored) file
#   --history            every commit's tree, message and paths
#
# What it blocks:
#   - home-directory paths (/home/<user>/, /Users/<user>/, C:\Users\<user>\),
#     and this machine's hostname and login (outside CI);
#   - private keys and tokens: PEM/OpenSSH/PGP private key blocks, GitHub
#     tokens (ghp_, gho_, ghu_, ghs_, ghr_, github_pat_), AWS access key ids,
#     Slack tokens, and `secret=`-style assignments of long literal values;
#   - .env files (except .env.example);
#   - author and committer emails that are not GitHub noreply addresses
#     (PRIVACY_ALLOWED_EMAILS, an extended regex, overrides the default);
#   - commit messages carrying agent session trailers or links.
#
# Private terms: a deployment's own words (a customer, a host, an internal
# product) never belong in a public list. Put one extended regex per line in
# `.privacy-terms` at the repository root (gitignored), or point
# PRIVACY_TERMS_FILE at a file elsewhere. A line `c:<regex>` matches
# case-sensitively; any other line (optionally `i:<regex>`) ignores case; `#`
# starts a comment. When the file exists every mode checks those terms too;
# `--private-terms` makes a missing file an error instead of a silent skip.
#
# A line that must contain a match (a test of this script, a documented
# example) can carry the marker `privacy-check: allow`.
#
# Exit status: 0 clean, 1 findings, 2 usage error.
set -u
export LC_ALL=C
root="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "privacy-check: not in a git repository" >&2; exit 2; }
cd "$root" || exit 2

mode=''
arg=''
require_terms=0
while [ $# -gt 0 ]; do
  case "$1" in
    --staged | --tree | --history) mode="$1" ;;
    --commit-msg | --range) mode="$1"; arg="${2:-}"; shift ;;
    --private-terms) require_terms=1 ;;
    -h | --help) sed -n '2,38p' "$0"; exit 0 ;;
    *) echo "privacy-check: unknown argument $1" >&2; exit 2 ;;
  esac
  shift
done
[ -n "$mode" ] || { echo "usage: privacy-check.sh --staged | --commit-msg <file> | --range <a>..<b> | --tree | --history [--private-terms]" >&2; exit 2; }

# --- patterns -------------------------------------------------------------
# Placeholder users that documentation and containers legitimately use.
HOME_RE='(/home/|/Users/|[Cc]:\\+Users\\+)[a-z_]'
HOME_OK='^(user|users|you|me|name|username|example|node|runner|app|ubuntu|root|<[^>]*>|\$[A-Za-z_]+|\{[^}]*\})$'
SECRET_RE='-----BEGIN ([A-Z0-9]+ )*PRIVATE KEY( BLOCK)?-----'
SECRET_RE+='|(^|[^A-Za-z0-9_])(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}'
SECRET_RE+='|github_pat_[A-Za-z0-9_]{60,}'
SECRET_RE+='|(^|[^A-Z0-9])(AKIA|ASIA)[0-9A-Z]{16}([^A-Z0-9]|$)'
SECRET_RE+='|xox[abposr]-[A-Za-z0-9-]{10,}'
# a long literal assigned to something named like a secret: `secret = "…"`,
# `API_KEY: …`, `password='…'` (values of 16+ token characters, not ${VARS})
ASSIGN_RE='(secret|passw(or)?d|passwd|api[_-]?key|access[_-]?key|private[_-]?key|auth[_-]?token|client[_-]?secret)[A-Za-z0-9_]*["'\'']?[[:space:]]*[:=][[:space:]]*["'\''][A-Za-z0-9+/_.~-]{16,}["'\'']'
ASSIGN_RE+='|(^|[[:space:]])(export[[:space:]]+)?[A-Z0-9_]*(SECRET|PASSWORD|PASSWD|TOKEN|API_KEY|ACCESS_KEY)[A-Z0-9_]*=[^$[:space:]'\''"]{16,}'
ALLOW='privacy-check: allow'
MSG_RE='Claude-Session|claude\.ai/code/session|Co-Authored-By:.*Claude|Generated with \[?Claude Code'
EMAIL_OK="${PRIVACY_ALLOWED_EMAILS:-@users\.noreply\.github\.com$|^noreply@github\.com$|^[0-9]+\+[A-Za-z0-9-]+\[bot\]@users\.noreply\.github\.com$}"

# this machine's own names (never in CI, never trivially short or generic)
LOCAL_RE=''
if [ -z "${CI:-}" ]; then
  for name in "$(hostname -s 2>/dev/null)" "$(id -un 2>/dev/null)"; do
    case "$name" in '' | localhost | root | node | runner | user | ubuntu | app) continue ;; esac
    [ "${#name}" -ge 4 ] || continue
    LOCAL_RE="${LOCAL_RE:+$LOCAL_RE|}(^|[^A-Za-z0-9])${name}([^A-Za-z0-9]|$)"
  done
fi

# private terms (local, gitignored)
TERMS_I=''
TERMS_C=''
terms_file="${PRIVACY_TERMS_FILE:-$root/.privacy-terms}"
if [ -f "$terms_file" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in '' | '#'*) continue ;; esac
    case "$line" in
      c:*) TERMS_C="${TERMS_C:+$TERMS_C|}${line#c:}" ;;
      i:*) TERMS_I="${TERMS_I:+$TERMS_I|}${line#i:}" ;;
      *) TERMS_I="${TERMS_I:+$TERMS_I|}$line" ;;
    esac
  done < "$terms_file"
elif [ "$require_terms" -eq 1 ]; then
  echo "privacy-check: --private-terms given but $terms_file does not exist" >&2
  exit 2
fi

hits=0
say() { # label, text
  printf '%s: %s\n' "$1" "${2:0:240}"
  hits=$((hits + 1))
}

# Check lines from stdin, formatted `<where>\t<text>`; print each finding.
# Matching runs grep over the whole batch; only candidate lines reach bash.
check_lines() {
  local label="$1" tmp where text user
  tmp="$(mktemp)"
  grep -v -F -e "$ALLOW" > "$tmp"
  local found prefix
  while IFS=$'\t' read -r where text; do
    # every home path on the line, not only the first
    while IFS= read -r found; do
      user="${found##*[/\\]}"
      prefix="${found%"$user"}"
      [[ "$user" =~ $HOME_OK ]] || say "$label" "$where: home path ($prefix$user/…)"
    done < <(printf '%s\n' "$text" | grep -o -E -e "${HOME_RE}[a-z0-9_.-]*")
  done < <(grep -E -e "$HOME_RE" "$tmp")
  while IFS=$'\t' read -r where text; do say "$label" "$where: private key or token"; done < <(grep -E -e "$SECRET_RE" "$tmp")
  while IFS=$'\t' read -r where text; do say "$label" "$where: secret-like assignment"; done < <(
    grep -i -E -e "$ASSIGN_RE" "$tmp" | grep -v -i -E -e '\$\{?[A-Za-z_]|<[^>]+>|process\.env|example|changeme|xxxx|test|dummy|fake|placeholder')
  if [ -n "$LOCAL_RE" ]; then
    while IFS=$'\t' read -r where text; do say "$label" "$where: this machine's hostname or login"; done < <(grep -E -e "$LOCAL_RE" "$tmp")
  fi
  if [ -n "$TERMS_I" ]; then
    while IFS=$'\t' read -r where text; do say "$label" "$where: private term"; done < <(grep -i -E -e "$TERMS_I" "$tmp")
  fi
  if [ -n "$TERMS_C" ]; then
    while IFS=$'\t' read -r where text; do say "$label" "$where: private term"; done < <(grep -E -e "$TERMS_C" "$tmp")
  fi
  rm -f "$tmp"
}

check_paths() { # label, paths on stdin
  local label="$1" path
  while IFS= read -r path; do
    case "$path" in
      .env.example | */.env.example) ;;
      .env | .env.* | */.env | */.env.*) say "$label" "$path: .env file" ;;
    esac
    case "$path" in
      *.pem | *.key | *.p12 | *.pfx | id_rsa | */id_rsa | id_ed25519 | */id_ed25519) say "$label" "$path: key file" ;;
    esac
    if [ -n "$TERMS_I" ] && printf '%s' "$path" | grep -q -i -E -e "$TERMS_I"; then say "$label" "$path: private term in path"; fi
    if [ -n "$TERMS_C" ] && printf '%s' "$path" | grep -q -E -e "$TERMS_C"; then say "$label" "$path: private term in path"; fi
  done
}

check_email() { # label, email
  if ! printf '%s' "$2" | grep -q -E -e "$EMAIL_OK"; then
    say "$1" "email <$2> is not a noreply address (set your git user.email to the GitHub noreply one)"
  fi
}

check_message() { # label, message text on stdin
  local label="$1" body
  body="$(cat)"
  if printf '%s' "$body" | grep -q -i -E -e "$MSG_RE"; then
    say "$label" "agent session trailer or link in the commit message"
  fi
  check_lines "$label" < <(printf '%s\n' "$body" | awk '{ printf "message:%d\t%s\n", NR, $0 }')
}

# Added lines of a diff, as `<file>:<line>\t<text>`.
added_lines() {
  awk '
    /^\+\+\+ / { file = substr($0, 5); sub(/^b\//, "", file); next }
    /^@@ / { split($3, a, ","); line = substr(a[1], 2) + 0; next }
    /^\+/ { printf "%s:%d\t%s\n", file, line, substr($0, 2); line++; next }
  '
}

# Every line of the files git lists, as `<file>:<line>\t<text>` (text files only).
tree_lines() { # git grep args (a tree-ish, or --untracked)
  git grep --no-color -I -n -e '' "$@" -- . 2>/dev/null |
    sed -E 's/^([^:]+:)?([^:]+):([0-9]+):/\2:\3\t/'
}

case "$mode" in
  --staged)
    check_lines staged < <(git diff --cached --no-color -U0 --diff-filter=ACMR | added_lines)
    check_paths staged < <(git diff --cached --name-only --diff-filter=ACMR)
    check_email author "${GIT_AUTHOR_EMAIL:-$(git config user.email)}"
    ;;
  --commit-msg)
    [ -f "$arg" ] || { echo "privacy-check: no message file" >&2; exit 2; }
    check_message commit-msg < <(grep -v '^#' "$arg")
    ;;
  --range)
    [ -n "$arg" ] || { echo "privacy-check: --range needs <a>..<b>" >&2; exit 2; }
    check_lines diff < <(git diff --no-color -U0 --diff-filter=ACMR "$arg" | added_lines)
    check_paths diff < <(git diff --name-only --diff-filter=ACMR "$arg")
    for commit in $(git rev-list --no-merges "$arg"); do
      check_email "commit ${commit:0:9} author" "$(git log -1 --format=%ae "$commit")"
      check_email "commit ${commit:0:9} committer" "$(git log -1 --format=%ce "$commit")"
      check_message "commit ${commit:0:9}" < <(git log -1 --format=%B "$commit")
    done
    ;;
  --tree)
    check_lines tree < <(tree_lines --untracked)
    check_paths tree < <(git ls-files; git ls-files --others --exclude-standard)
    # private terms split over two comment lines: join continuation lines, then match
    if [ -n "$TERMS_I" ]; then
      while IFS=$'\t' read -r f term; do say joined "$f: private term split over lines"; done < <(
      { git ls-files; git ls-files --others --exclude-standard; } |
        while IFS= read -r f; do [ -f "$f" ] && printf '%s\0' "$f"; done |
        TERMS="$TERMS_I" xargs -0 perl -0777 -ne '
          next if /\0/;
          my $text = $_;
          my %one = map { $_ => 1 } ($text =~ /($ENV{TERMS})/gi);
          $text =~ s/[ \t]*\n[ \t]*(?:\*(?!\/)|\/\/|#)?[ \t]*/ /g;
          while ($text =~ /($ENV{TERMS})/gi) { print "$ARGV\t$1\n" unless $one{$1} }' 2>/dev/null)
    fi
    ;;
  --history)
    for commit in $(git rev-list --all); do
      check_lines "history ${commit:0:9}" < <(tree_lines "$commit")
      check_paths "history ${commit:0:9}" < <(git ls-tree -r --name-only "$commit")
      check_message "message ${commit:0:9}" < <(git log -1 --format=%B "$commit")
    done
    ;;
esac

if [ "$hits" -eq 0 ]; then
  terms='no private terms file'
  [ -f "$terms_file" ] && terms='private terms checked'
  echo "privacy-check ${mode#--}: clean ($terms)"
  exit 0
fi
echo "privacy-check ${mode#--}: $hits finding(s)" >&2
exit 1
