#!/bin/bash
# Self-check for filelock. Run: bash filelock.test.sh   (uses a throwaway FILELOCK_ROOT)
FL="$(cd "$(dirname "$0")" && pwd)/filelock"
export FILELOCK_ROOT; FILELOCK_ROOT=$(mktemp -d); trap 'rm -rf "$FILELOCK_ROOT"' EXIT
fails=0
t() { local want=$1 label=$2; shift 2; local out rc; out=$("$@" 2>&1); rc=$?
      [ "$rc" = "$want" ] && echo "ok   $label" || { echo "FAIL $label: exit $rc, wanted $want: $out"; fails=$((fails + 1)); }; }
has() { local label=$1 pat=$2 out; shift 2; out=$("$@" 2>&1)
        case "$out" in *"$pat"*) echo "ok   $label" ;; *) echo "FAIL $label: '$out' lacks '$pat'"; fails=$((fails + 1)) ;; esac; }

t 0 "acquire free"                      $FL acquire /x/f.txt a1
t 0 "same owner again"                  $FL acquire /x/f.txt a1 0
t 3 "other owner, WAIT_S 0"             $FL acquire /x/f.txt a2 0
has "timeout names holder"  "held by a1" $FL acquire /x/f.txt a2 0
t 4 "release by non-owner"              $FL release /x/f.txt a2
s=$SECONDS; $FL acquire /x/f.txt a2 1 >/dev/null; [ $((SECONDS - s)) -le 2 ] && echo "ok   WAIT_S 1 returns in about 1 s" || { echo "FAIL WAIT_S 1 took $((SECONDS - s)) s"; fails=$((fails + 1)); }
has "status shows the real key"  "/x/f.txt  held by a1" $FL status
t 0 "release by owner"                  $FL release /x/f.txt a1

t 0 "acquire /x/a/b"                    $FL acquire /x/a/b o1
t 0 "/x/a_b is a different key"         $FL acquire /x/a_b o2 0
t 0 "/x/a b is a different key"         $FL acquire "/x/a b" o3 0
t 3 "/x/y/../a/b is the same key"       $FL acquire /x/y/../a/b o4 0
t 3 "/x//a/b is the same key"           $FL acquire /x//a/b o4 0
t 2 "relative path with / is refused"   $FL acquire assets/manifest.json o5 0
t 0 "plain name works"                  $FL acquire device:s1 o6 0
t 2 "non-numeric WAIT_S"                $FL acquire /x/z o7 abc
t 2 "missing owner"                     $FL acquire /x/z

LONG=/$(printf 'd%.0s' $(seq 1 130))/$(printf 'e%.0s' $(seq 1 130))/f.txt
t 0 "long key acquire"                  $FL acquire "$LONG" o8 0
t 3 "long key excludes"                 $FL acquire "$LONG" o9 0
has "long key status"  "(long key, hashed)" $FL status

t 0 "break a held lock"                 $FL break /x/a/b
t 0 "acquire after break"               $FL acquire /x/a/b o1 0

rm -rf "$FILELOCK_ROOT"; mkdir -p "$FILELOCK_ROOT"; res=$FILELOCK_ROOT.res; : > "$res"
for i in $(seq 1 10); do ( $FL acquire /x/race r$i 0 >/dev/null; echo $? >> "$res" ) & done; wait
[ "$(grep -c '^0$' "$res")" = 1 ] && echo "ok   10 racing acquires, one winner" || { echo "FAIL race: $(tr '\n' ' ' < "$res")"; fails=$((fails + 1)); }
rm -f "$res"
[ "$fails" = 0 ] && echo "all passed" || { echo "$fails failed"; exit 1; }
