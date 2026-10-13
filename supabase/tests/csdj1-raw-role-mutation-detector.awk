# ====================================================================
# DÉTECTEUR DE MUTATIONS DE RÔLE NON GARDÉES
# CSDJ1-AUD-07-RAW-ROLE-DETECTOR-01
#
# Il répond à une seule question, pour chaque commande shell d'un
# harnais CSDJ-1 : si cette commande fait exécuter une mutation de rôle
# PostgreSQL, passe-t-elle par le prédicat d'identité, ou directement ?
#
# POURQUOI SIX ÉTAPES, ET PLUS DE RUSTINES
# ----------------------------------------
# Quatre audits ont trouvé quatre façons de tromper un détecteur qui
# raisonnait sur l'orthographe d'une ligne : la casse, la forme du
# littéral, la fuite d'état entre commandes, l'apostrophe d'un
# commentaire. La cinquième -- la continuation À L'INTÉRIEUR d'un
# argument entre guillemets, et le retour à la ligne comme simple blanc
# SQL -- montre que la liste des orthographes n'a pas de fin :
#
#   q "alter \          q "alter
#   role fixture ...;"  role fixture ...;"
#
# Bash passe, dans les deux cas, du SQL que PostgreSQL lit comme
# « ALTER ROLE ». Corriger ces deux formes-là ne ferait que déplacer la
# frontière.
#
# On ne compare donc plus des textes : on construit une REPRÉSENTATION
# NORMALISÉE, et c'est elle qu'on interroge. Six étapes explicites :
#
#   A. reconstitution LEXICALE d'une commande shell ;
#   B. normalisation SÉMANTIQUE du shell -- continuations retirées (y
#      compris entre guillemets), commentaires ignorés, guillemets
#      consommés comme le shell les consomme ;
#   C. le texte RÉELLEMENT transmis au client est ce qui sera analysé ;
#   D. normalisation SQL -- commentaires retirés, littéraux de DONNÉES
#      neutralisés, corps à dollars conservés, blancs réduits ;
#   E. reconnaissance du mot-clé, insensible à la casse ;
#   F. classement gardé / brut de la commande.
#
# Chaque étape est lisible seule, et chacune est éprouvée par les
# fixtures du harnais -- D1-D7, R1-R5, C1-C5, E1-E10, F1-F6, P1-P3 --
# puis par la contre-épreuve adversariale de la section [J], qui
# engendre une matrice de formes équivalentes et confronte CHAQUE
# verdict à ce que PostgreSQL exécute réellement.
#
# INVARIANT
# ---------
# Si Bash transmet du SQL que PostgreSQL lit comme CREATE ROLE ou
# ALTER ROLE, le détecteur rend GARDEE ou NON-GARDEE -- jamais
# « rien ». Une commande qu'il ne sait pas classer est rapportée
# SANS-OUVREUR, et le harnais la traite comme un échec. Mieux vaut un
# signalement de trop qu'une mutation brute déclarée gardée.
#
# LIMITES ASSUMÉES, ET DOCUMENTÉES
# --------------------------------
# 1. Un littéral SQL entre apostrophes est tenu pour des DONNÉES --
#    sauf quand il est l'argument d'EXECUTE, seule forme par laquelle
#    ces harnais font exécuter du SQL logé dans un littéral (relecture
#    exhaustive : « execute 'create role … ' » et « execute 'alter role
#    … ' », aucun « execute format(…) », aucune requête préparée). Un
#    littéral exécuté autrement ne serait pas vu ; si l'une des deux
#    implémentations devait en employer une, ce commentaire est
#    l'endroit où il faudrait le dire.
# 2. L'EXPANSION DES PARAMÈTRES n'est pas modélisée. Le détecteur sait
#    lire « "crea""te role" » -- la concaténation du shell -- mais pas
#    suivre un verbe rangé dans une variable jusqu'à son exécution.
#    Une AFFECTATION portant le verbe est donc rapportée
#    SANS-OUVREUR : fermé, et non présumé inoffensif. C'est le cas X1
#    de la section [J], et la raison pour laquelle les verbes des
#    fixtures sont assemblés en DEUX variables jamais adjacentes.
# 3. Entre APOSTROPHES, « barre oblique inverse + saut de ligne » n'est
#    pas une continuation : bash les transmet tels quels, PostgreSQL
#    refuse l'instruction, et le détecteur ne signale rien. Les deux
#    moitiés de ce fait sont vérifiées par le cas X2 -- l'absence de
#    signalement y est accompagnée de la preuve que le rôle ne bouge
#    pas.
#
# Ce fichier vit SÉPARÉMENT des harnais qu'il analyse : logé dans le
# fichier qu'il scrute, un détecteur se dénonce lui-même, et l'on finit
# par lui ajouter des exceptions -- lesquelles sont autant de trous.
# ====================================================================

# ── ÉTAPE D ── Normalisation SQL.
#
# Retire ce que PostgreSQL ne lit pas comme du code, conserve ce qu'il
# exécute, et réduit tout blanc à une espace unique. Les blancs SQL sont
# l'espace, la tabulation, le retour chariot et le saut de ligne : c'est
# pourquoi « ALTER<LF>ROLE » est une mutation comme « ALTER ROLE ».
function sql_normalize(s,   out, i, n, c, c2, lastword, curword, tag, j, k, keep, closing) {
  out = ""
  lastword = ""
  curword = ""
  n = length(s)
  i = 1
  while (i <= n) {
    c = substr(s, i, 1)

    # Commentaire de fin de ligne : « -- » jusqu'au saut de ligne.
    if (c == "-" && substr(s, i + 1, 1) == "-") {
      while (i <= n && substr(s, i, 1) != "\n") i++
      out = out " "
      if (curword != "") { lastword = curword; curword = "" }
      continue
    }

    # Commentaire en bloc, imbricable comme chez PostgreSQL.
    if (c == "/" && substr(s, i + 1, 1) == "*") {
      k = 1
      i += 2
      while (i <= n && k > 0) {
        if (substr(s, i, 2) == "/*") { k++; i += 2; continue }
        if (substr(s, i, 2) == "*/") { k--; i += 2; continue }
        i++
      }
      out = out " "
      if (curword != "") { lastword = curword; curword = "" }
      continue
    }

    # Corps à dollars : « $$ … $$ », « $tag$ … $tag$ ». C'est un
    # littéral pour l'analyseur, mais le corps d'un DO est EXÉCUTÉ : on
    # le CONSERVE. Le retirer masquerait une mutation réelle.
    if (c == "$") {
      j = i + 1
      tag = ""
      if (substr(s, j, 1) ~ /[A-Za-z_]/) {
        while (j <= n && substr(s, j, 1) ~ /[A-Za-z0-9_]/) { tag = tag substr(s, j, 1); j++ }
      }
      if (substr(s, j, 1) == "$") {
        closing = "$" tag "$"
        j++
        k = index(substr(s, j), closing)
        if (k > 0) {
          out = out " " substr(s, j, k - 1) " "
          i = j + k - 1 + length(closing)
          lastword = ""; curword = ""
          continue
        }
      }
      out = out c
      i++
      continue
    }

    # Littéral entre apostrophes. DONNÉES, sauf argument d'EXECUTE.
    # « lastword » est le dernier MOT COMPLET : les blancs ne l'effacent
    # pas, sans quoi « execute 'alter role …' » -- avec son espace --
    # échapperait à la règle, et la seule forme par laquelle ces harnais
    # font exécuter du SQL logé dans un littéral serait manquée.
    if (c == "'") {
      if (curword != "") { lastword = curword; curword = "" }
      keep = (lastword == "execute")
      i++
      while (i <= n) {
        c2 = substr(s, i, 1)
        if (c2 == "'") {
          if (substr(s, i + 1, 1) == "'") {       # apostrophe échappée
            if (keep) out = out "'"
            i += 2
            continue
          }
          i++
          break
        }
        if (keep) out = out c2
        i++
      }
      out = out " "
      lastword = ""; curword = ""
      continue
    }

    if (c ~ /[A-Za-z0-9_]/) {
      curword = curword tolower(c)
      out = out c
      i++
      continue
    }

    if (curword != "") { lastword = curword; curword = "" }
    out = out c
    i++
  }

  # Blancs SQL réduits : espace, tabulation, retour chariot, saut de
  # ligne -- et les suites de blancs valent une espace.
  gsub(/[ \t\r\n\013\f]+/, " ", out)
  return out
}

# ── ÉTAPE E ── Le mot-clé, insensible à la casse.
function has_role_mutation(expanded,   norm) {
  norm = tolower(sql_normalize(expanded))
  return (norm ~ /(create|alter|drop) role/)
}

# ── ÉTAPE F ── Gardé ou brut. Le classement porte sur le TEXTE
#    VERBATIM de la commande : c'est là que se lisent les appels.
function classify(verbatim,   kind) {
  kind = "none"
  if (verbatim ~ /csdj1_identity_(mutate|install|uninstall)/ \
      || verbatim ~ /RESTORE_SQL=/ || verbatim ~ /PROBE_MUTATION=/) kind = "garde"
  # Un appel BRUT l'emporte sur un appel gardé présent dans la même
  # commande : en cas de doute, le classement défavorable gagne.
  # Les formes d'argument reconnues : apostrophe, guillemet,
  # continuation, et document en ligne (« << DELIM »).
  if (verbatim ~ /(^|[^a-z_])(q|qw)[ \t]*["'\\<]/ \
      || verbatim ~ /csdj1_runner_[a-z_]+[ \t]*["'\\<]/ \
      || verbatim ~ /(psql|probe|sql_value|run_sql)[ \t]+(-|["']|\$|<)/) kind = "brut"
  return kind
}

function report(kind, cmd, note) {
  # UN signalement, UNE ligne : le harnais compte des lignes, et une
  # commande reconstituée contient des sauts de ligne.
  gsub(/[ \t\r\n]+/, " ", cmd)
  sub(/^ /, "", cmd)
  if (length(cmd) > 240) cmd = substr(cmd, 1, 237) "..."
  if (kind == "brut")
    printf "NON-GARDEE\t%s\t%s\t%s\n", FILENAME, cmd, note
  else if (kind == "garde")
    printf "GARDEE\t%s\t%s\n", FILENAME, cmd
  else
    printf "SANS-OUVREUR\t%s\t%s\n", FILENAME, cmd
}

function finish(   kind) {
  if (cmdraw ~ /^[ \t\n]*$/) { cmdraw = ""; cmdexp = ""; return }
  kind = classify(cmdraw)
  lastkind = kind
  if (has_role_mutation(cmdexp)) report(kind, cmdraw, "commande complete")
  cmdraw = ""
  cmdexp = ""
}

BEGIN {
  q = ""; cmdraw = ""; cmdexp = ""; cont = 0
  hd = ""; hdkind = ""; hdbody = ""; hdlit = 0; lastkind = "none"
}

# Corps d'un document en ligne : du TEXTE, pas du shell. Il ne touche
# pas l'état de citation, mais une mutation qu'il contient appartient
# bien à la commande qui l'a ouvert.
#
# Le corps est ACCUMULÉ puis analysé D'UN SEUL BLOC : du SQL logé dans un
# document en ligne s'étend sur plusieurs lignes, et « alter » en fin de
# ligne suivi de « role » en tête de la suivante est une mutation que
# PostgreSQL exécute. Une analyse ligne à ligne la manquerait -- c'est
# exactement la classe de défauts que cette remédiation ferme.
hd != "" {
  if ($0 ~ "^[ \t]*" hd "[ \t]*$") {
    # Délimiteur NON cité : Bash retire « barre oblique inverse + saut de
    # ligne » dans le corps. Délimiteur cité : il n'y touche pas.
    if (!hdlit) gsub(/\\\n/, "", hdbody)
    if (has_role_mutation(hdbody))
      report(hdkind, hdbody, "corps de document en ligne")
    hd = ""; hdkind = ""; hdbody = ""; hdlit = 0
    next
  }
  hdbody = hdbody $0 "\n"
  next
}

# ── ÉTAPES A, B et C ── Reconstitution lexicale, normalisation shell,
#    et accumulation de DEUX textes : le verbatim (pour reconnaître les
#    appels) et l'EXPANSÉ (ce que le client reçoit réellement).
{
  line = $0
  n = length(line)
  i = 1
  hdpending = ""
  hdpendlit = 0

  while (i <= n) {
    c = substr(line, i, 1)

    if (q == "") {
      if (c == "\\") {
        if (i == n) { cont = 1; i++; continue }           # continuation
        cmdraw = cmdraw substr(line, i, 2)
        cmdexp = cmdexp substr(line, i + 1, 1)
        i += 2
        continue
      }
      # Commentaire : « # » en début de mot, hors citation. Le reste de
      # la ligne physique est abandonné, et n'affecte RIEN.
      if (c == "#" && (cmdraw == "" || substr(cmdraw, length(cmdraw), 1) ~ /[ \t\n;&|(]/)) break
      if (c == "'")  { q = "'";  cmdraw = cmdraw c; i++; continue }
      if (c == "\"") { q = "\""; cmdraw = cmdraw c; i++; continue }
      if (c == ";" || c == "&" || c == "|") { finish(); i++; continue }
      if (c == "<" && substr(line, i, 2) == "<<") {
        j = i + 2
        if (substr(line, j, 1) == "-") j++
        dq = substr(line, j, 1)
        if (dq == "'" || dq == "\"") {
          j++
          hdpending = ""
          hdpendlit = 1                 # délimiteur cité : aucune expansion
          while (j <= n && substr(line, j, 1) != dq) { hdpending = hdpending substr(line, j, 1); j++ }
          j++
        } else {
          hdpending = ""
          hdpendlit = 0
          while (j <= n && substr(line, j, 1) ~ /[A-Za-z0-9_]/) { hdpending = hdpending substr(line, j, 1); j++ }
        }
        # Le « << DELIM » reste dans le VERBATIM : c'est une forme
        # d'argument, et l'étape F doit pouvoir y reconnaître l'appel.
        cmdraw = cmdraw substr(line, i, j - i)
        i = j
        continue
      }
      cmdraw = cmdraw c; cmdexp = cmdexp c; i++; continue
    }

    if (q == "'") {                                        # aucun échappement
      if (c == "'") { q = ""; cmdraw = cmdraw c; i++; continue }
      cmdraw = cmdraw c; cmdexp = cmdexp c; i++; continue
    }

    # q == guillemet double.
    if (c == "\\") {
      # Barre oblique inverse en FIN DE LIGNE, entre guillemets : Bash
      # retire la barre ET le saut de ligne. C'est la forme que l'audit
      # a trouvée, et elle ne laisse aucune trace dans l'argument.
      if (i == n) { cont = 1; i++; continue }
      cmdraw = cmdraw substr(line, i, 2)
      cmdexp = cmdexp substr(line, i + 1, 1)
      i += 2
      continue
    }
    if (c == "\"") { q = ""; cmdraw = cmdraw c; i++; continue }
    cmdraw = cmdraw c; cmdexp = cmdexp c; i++; continue
  }

  # Une continuation ne laisse RIEN : ni saut de ligne, ni fin de
  # commande. L'état de citation, lui, est conservé.
  if (cont) { cont = 0; next }
  # Un argument encore ouvert : le saut de ligne en fait partie, et
  # PostgreSQL le lira comme un blanc.
  if (q != "") { cmdraw = cmdraw "\n"; cmdexp = cmdexp "\n"; next }
  finish()
  if (hdpending != "") { hd = hdpending; hdkind = lastkind; hdbody = ""; hdlit = hdpendlit }
}

# Une commande -- ou un corps de document en ligne -- laissé ouvert en
# fin de fichier ne peut pas être classé avec certitude : on le
# rapporte, défavorablement.
END {
  if (cmdraw !~ /^[ \t\n]*$/) {
    if (has_role_mutation(cmdexp))
      printf "SANS-OUVREUR\t%s\t%s\t%s\n", FILENAME, cmdraw, "commande non terminee en fin de fichier"
  }
  if (hd != "" && has_role_mutation(hdbody))
    printf "SANS-OUVREUR\t%s\t%s\t%s\n", FILENAME, hdbody, "document en ligne non termine en fin de fichier"
}
