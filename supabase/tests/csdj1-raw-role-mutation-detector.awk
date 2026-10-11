# ====================================================================
# DÉTECTEUR DE MUTATIONS DE RÔLE NON GARDÉES
# CSDJ1-AUD-07-RAW-ROLE-DETECTOR-01
#
# Il répond à une seule question, pour chaque commande shell d'un
# harnais CSDJ-1 : si cette commande mute un rôle PostgreSQL, le fait-
# elle à travers le prédicat d'identité, ou directement ?
#
# POURQUOI UN LEXEUR, ET PLUS DES HEURISTIQUES DE LIGNE
# -----------------------------------------------------
# Les versions précédentes raisonnaient ligne par ligne, en comptant
# les guillemets pour devine* si un argument restait ouvert. Trois
# audits successifs ont trouvé trois façons de tromper ce comptage, et
# la dernière est la plus parlante :
#
#   csdj1_identity_mutate "perform 1;" # l'initialisation est terminee
#   q \
#   'alter role fixture bypassrls;'
#
# L'apostrophe du COMMENTAIRE était comptée comme un délimiteur. L'état
# « gardé » survivait donc à une commande pourtant terminée, la
# continuation par barre oblique inverse n'était pas reconnue, et la
# mutation BRUTE de la troisième ligne était déclarée GARDÉE. Elle
# s'exécutait pourtant, et changeait réellement le rôle.
#
# On ne corrige donc plus le comptage : on le remplace. Ce fichier
# reconstitue les COMMANDES, en modélisant ce qu'il faut de la syntaxe
# du shell -- et rien de plus :
#
#   - texte ordinaire ;
#   - texte entre apostrophes (aucune échappement à l'intérieur, c'est
#     la règle du shell) ;
#   - texte entre guillemets (où la barre oblique inverse échappe) ;
#   - commentaire : « # » en début de mot, HORS citation, jusqu'à la fin
#     de la ligne physique -- et il n'affecte AUCUN état ;
#   - continuation : barre oblique inverse en fin de ligne, hors
#     citation ;
#   - fin de commande : « ; », « & », « | », ou fin de ligne hors
#     citation et hors continuation ;
#   - document en ligne (heredoc) : son corps est du texte, pas du
#     shell, mais une mutation qu'il contient appartient à la commande
#     qui l'a ouvert.
#
# Chaque commande est classée SEULE. Aucun état ne se propage d'une
# commande à la suivante : la classe entière de défauts « fuite d'état »
# disparaît par construction, et non par correctif.
#
# FERMÉ PAR DÉFAUT
# ----------------
# Une commande qui mute un rôle sans qu'on puisse désigner l'appel
# gardé qui la porte est rapportée SANS-OUVREUR, et le harnais la
# traite comme un échec. Mieux vaut un signalement de trop qu'une
# mutation brute déclarée gardée : c'est précisément ce mensonge qui a
# tenu AUD-07 ouvert trois tours de plus.
#
# Ce fichier vit SÉPARÉMENT des harnais qu'il analyse. Un détecteur
# logé dans le fichier qu'il scrute se dénonce lui-même, et l'on finit
# par lui ajouter des exceptions -- lesquelles sont autant de trous.
# ====================================================================

function classify(cmd,   low, kind) {
  kind = "none"
  if (cmd ~ /csdj1_identity_(mutate|install|uninstall)/ \
      || cmd ~ /RESTORE_SQL=/ || cmd ~ /PROBE_MUTATION=/) kind = "garde"
  # Un appel BRUT l'emporte sur un appel gardé présent dans la même
  # commande : en cas de doute, on choisit le classement défavorable.
  if (cmd ~ /(^|[^a-z_])(q|qw)[ \t]*["']/ \
      || cmd ~ /csdj1_runner_[a-z_]+[ \t]*["']/ \
      || cmd ~ /(psql|probe|sql_value|run_sql)[ \t]+(-|["']|\$)/) kind = "brut"
  return kind
}

function has_role_mutation(cmd) {
  # Insensible à la casse : « Alter Role » est une mutation comme une
  # autre, et c'est bien ainsi que PostgreSQL la lit.
  return (tolower(cmd) ~ /(create|alter|drop)[ \t]+role/)
}

function report(kind, cmd, note) {
  if (kind == "brut")
    printf "NON-GARDEE\t%s\t%s\t%s\n", FILENAME, cmd, note
  else if (kind == "garde")
    printf "GARDEE\t%s\t%s\n", FILENAME, cmd
  else
    printf "SANS-OUVREUR\t%s\t%s\n", FILENAME, cmd
}

function finish(   kind) {
  if (buf ~ /^[ \t\n]*$/) { buf = ""; return }
  kind = classify(buf)
  lastkind = kind
  if (has_role_mutation(buf)) report(kind, buf, "commande complete")
  buf = ""
}

BEGIN { q = ""; buf = ""; cont = 0; hd = ""; hdkind = ""; lastkind = "none" }

# ── Corps d'un document en ligne : du TEXTE, pas du shell. Il ne touche
#    pas l'état de citation, mais une mutation qu'il contient appartient
#    bien à la commande qui l'a ouvert.
hd != "" {
  if ($0 ~ "^[ \t]*" hd "[ \t]*$") { hd = ""; hdkind = ""; next }
  if (has_role_mutation($0)) report(hdkind, $0, "corps de document en ligne")
  next
}

{
  line = $0
  n = length(line)
  i = 1
  hdpending = ""

  while (i <= n) {
    c = substr(line, i, 1)

    if (q == "") {
      if (c == "\\") {
        if (i == n) { cont = 1; i++; continue }          # continuation
        buf = buf substr(line, i + 1, 1); i += 2; continue
      }
      # Commentaire : « # » en début de mot, hors citation. Le reste de
      # la ligne physique est abandonné, et n'affecte RIEN.
      if (c == "#" && (buf == "" || substr(buf, length(buf), 1) ~ /[ \t\n;&|(]/)) break
      if (c == "'")  { q = "'";  buf = buf c; i++; continue }
      if (c == "\"") { q = "\""; buf = buf c; i++; continue }
      if (c == ";" || c == "&" || c == "|") { finish(); i++; continue }
      # Ouverture d'un document en ligne : « << », « <<- », délimiteur
      # éventuellement cité.
      if (c == "<" && substr(line, i, 2) == "<<") {
        j = i + 2
        if (substr(line, j, 1) == "-") j++
        dq = substr(line, j, 1)
        if (dq == "'" || dq == "\"") {
          j++
          hdpending = ""
          while (j <= n && substr(line, j, 1) != dq) { hdpending = hdpending substr(line, j, 1); j++ }
          j++
        } else {
          hdpending = ""
          while (j <= n && substr(line, j, 1) ~ /[A-Za-z0-9_]/) { hdpending = hdpending substr(line, j, 1); j++ }
        }
        i = j
        continue
      }
      buf = buf c; i++; continue
    }

    if (q == "'") {                                       # aucune échappement
      if (c == "'") q = ""
      buf = buf c; i++; continue
    }

    # q == guillemet double : la barre oblique inverse y échappe.
    if (c == "\\" && i < n) { buf = buf substr(line, i, 2); i += 2; continue }
    if (c == "\"") { q = ""; buf = buf c; i++; continue }
    buf = buf c; i++; continue
  }

  if (q != "") { buf = buf "\n"; next }                   # argument encore ouvert
  if (cont) { cont = 0; next }                            # continuation
  finish()
  if (hdpending != "") { hd = hdpending; hdkind = lastkind }
}

# Une commande laissée ouverte en fin de fichier ne peut pas être
# classée avec certitude : on la rapporte, défavorablement.
END {
  if (buf !~ /^[ \t\n]*$/) {
    if (has_role_mutation(buf))
      printf "SANS-OUVREUR\t%s\t%s\t%s\n", FILENAME, buf, "commande non terminee en fin de fichier"
  }
}
