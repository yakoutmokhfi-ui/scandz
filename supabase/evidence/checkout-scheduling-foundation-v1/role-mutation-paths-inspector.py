#!/usr/bin/env python3
"""Inspection INDEPENDANTE des chemins de mutation de role (CSDJ-1).

But : repondre, sans employer le detecteur awk, a la question du
mandat -- « tous les chemins REELS de mutation de role sont-ils
gardes ? ».

C'est une SECONDE implementation, ecrite separement, en python, et
deliberement plus simple : elle ne normalise pas le SQL, n'accumule pas
les corps de documents en ligne et ne cherche pas les equivalences de
blancs. Elle fait une seule chose : pour chaque ligne physique, dire
quelle COMMANDE la porte, en suivant les citations et les continuations
du shell ; puis, pour chaque occurrence textuelle d'un verbe de mutation
de role, lire le texte de cette commande.

Deux implementations independantes qui concluent la meme chose valent
mieux qu'une. Si elles divergent, c'est la divergence qu'il faut
expliquer.
"""
import re
import sys

VERB = re.compile(r'(create|alter|drop)[\s\\]+role\b', re.I)
GUARD = re.compile(r'csdj1_identity_(mutate|install|uninstall|run_guarded)'
                   r'|RESTORE_SQL=|PROBE_MUTATION=')
RAW = re.compile(r'(^|[^A-Za-z0-9_])(q|qw)[ \t]*["\'\\<]'
                 r'|csdj1_runner_[a-z_]+[ \t]*["\'\\<]'
                 r'|\$PSQL|\$CSDJ1_ID_RUNNER')


def owners(lines):
    """Rend, pour chaque indice de ligne, l'indice de la ligne qui OUVRE
    la commande dont elle fait partie. Etat suivi : citation simple,
    citation double, continuation, commentaire, corps de document en
    ligne."""
    own = [None] * len(lines)
    start = None
    quote = ''
    cont = False
    heredoc = None
    for n, line in enumerate(lines):
        if heredoc is not None:
            own[n] = start
            if line.strip() == heredoc:
                heredoc = None
                start = None
            continue
        if start is None and quote == '' and not cont:
            if not line.strip():
                own[n] = None
                continue
            start = n
        own[n] = start
        pending_hd = None
        i = 0
        cont = False
        while i < len(line):
            c = line[i]
            if quote == '':
                if c == '\\':
                    if i == len(line) - 1:
                        cont = True
                    i += 2
                    continue
                if c == '#' and (i == 0 or line[i - 1] in ' \t;&|('):
                    break
                if c in '"\'':
                    quote = c
                    i += 1
                    continue
                if line[i:i + 2] == '<<':
                    j = i + 2
                    if j < len(line) and line[j] == '-':
                        j += 1
                    if j < len(line) and line[j] in '"\'':
                        d = line[j]
                        j += 1
                        tag = ''
                        while j < len(line) and line[j] != d:
                            tag += line[j]
                            j += 1
                        j += 1
                    else:
                        tag = ''
                        while j < len(line) and (line[j].isalnum() or line[j] == '_'):
                            tag += line[j]
                            j += 1
                    if tag:
                        pending_hd = tag
                    i = j
                    continue
                i += 1
                continue
            if quote == "'":
                if c == "'":
                    quote = ''
                i += 1
                continue
            # quote == '"'
            if c == '\\':
                if i == len(line) - 1:
                    cont = True
                i += 2
                continue
            if c == '"':
                quote = ''
            i += 1
        if cont or quote != '':
            continue
        if pending_hd is not None:
            heredoc = pending_hd
            continue
        start = None
    return own


def command_text(lines, own, n):
    s = own[n]
    if s is None:
        return None, None
    k = s
    out = []
    while k < len(lines) and (own[k] == s):
        out.append(lines[k])
        k += 1
    return s + 1, '\n'.join(out)


total = 0
bad = 0
for path in sys.argv[1:]:
    lines = open(path, encoding='utf-8').read().split('\n')
    own = owners(lines)
    print('== %s' % path)
    for n, line in enumerate(lines):
        if not VERB.search(line):
            continue
        total += 1
        first, text = command_text(lines, own, n)
        if text is None:
            print('  ! %5d  AUCUNE COMMANDE' % (n + 1))
            bad += 1
            continue
        stripped = text.strip()
        if stripped.startswith('#'):
            verdict = 'COMMENTAIRE (aucun code)'
        elif re.match(r'^[A-Za-z_][A-Za-z0-9_]*\s*\(\s*\)\s*\{', stripped):
            verdict = 'CORPS DE FONCTION -> voir ses appelants'
        elif RAW.search(text):
            verdict = 'APPEL BRUT'
        elif GUARD.search(text):
            verdict = 'GARDE'
        elif re.match(r'^(printf|cat|echo|\{ printf)', stripped):
            verdict = 'GENERATION DE TEXTE (fixture, non executee ici)'
        else:
            verdict = 'INDETERMINE'
        flag = '!' if verdict in ('APPEL BRUT', 'INDETERMINE') else ' '
        if flag == '!':
            bad += 1
        print('  %s %5d  (commande ouverte ligne %5d)  %-46s %s'
              % (flag, n + 1, first, verdict, line.strip()[:60]))
print()
print('occurrences du verbe de mutation : %d' % total)
print('chemins BRUTS ou INDETERMINES    : %d' % bad)
sys.exit(1 if bad else 0)
