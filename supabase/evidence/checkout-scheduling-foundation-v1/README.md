# CHECKOUT SCHEDULING FOUNDATION v1.6 (CSDJ-1) — paquet de preuves
## Sixième remédiation : collision de sentinelle, détecteur de mutations brutes

| candidat | verdict |
| --- | --- |
| `091c3f0` → `7420bec` | six verdicts FAIL successifs, détaillés plus bas |
| `8dafd78` | **ce candidat** |

Aucun des six candidats refusés n'est amendé ni réécrit. **Aucune
recomposition.** L'oracle Python, la fixture, le résolveur et le SQL du
lot sont **intacts** — `git diff` sur ces chemins est vide — et seulement
**rejoués en régression**. **CSDJ-2 n'est pas commencé.**

---

## §0 — Les deux blockers de ce tour

Le premier est le plus instructif : mon propre parseur se réservait deux
octets sans le dire à personne.

### §0.1 Collision de sentinelle — `CSDJ1-AUD-07-SOCKET-SENTINEL-01`

Le parseur employait `chr(1)` et `chr(2)` comme sentinelles internes :
`chr(1)` pour mettre de côté un guillemet doublé, `chr(2)` pour marquer
une virgule hors citation. Or **ces octets ne sont réservés par aucune
syntaxe PostgreSQL**. Linux n'interdit dans un nom de fichier que `/` et
l'octet nul ; un répertoire peut donc les contenir, et un serveur démarre
parfaitement sur un tel répertoire — mesuré sur ce poste, pas déduit.

**Reproduit avant correction**, et dans les deux sens :

| liste réelle | attendu | verdict |
| --- | --- | --- |
| `<r>/foo<chr(2)>bar,<r>/plain` | `<r>/foo` | **accepté** — l'octet des données est pris pour un séparateur, le fragment devient une entrée |
| `<r>/foo<chr(1)>bar,…` | `<r>/foo"bar` *(chemin inexistant)* | **accepté** — le `chr(1)` est restitué en guillemet |
| `<r>/foo<chr(1)>bar,…` | l'entrée **réelle** | **refusé** |

Une fausse identité acceptée, et l'entrée réelle refusée.

**La correction** est celle que le mandat préfère : la liste **brute** est
refusée avant toute substitution, sous le nom `socket_octets_reserves`.
Le refus porte aussi sur l'attendu, à la déclaration du contrat —
accepter d'un côté ce qu'on refuse de l'autre serait une asymétrie, donc
une faille. Les sentinelles ne sont pas déplacées ailleurs : l'entrée est
refusée.

**Pourquoi refuser plutôt que supporter.** PostgreSQL permet ces octets
dans un chemin ; le harnais les refuse. Un cluster jetable n'a jamais
besoin d'un répertoire de socket contenant un octet de contrôle, et si
quelqu'un en rencontrait un, un refus **nommé** lui dirait exactement
pourquoi — là où une acceptation silencieuse lui aurait menti sur
l'identité du serveur qu'il mute.

**Les contrôles tournent sur de vrais clusters** portant ces octets.
Chacun démarre d'abord avec une liste **ordinaire**, pour que le marqueur
et le rôle témoin soient posés **légitimement** : sans cela le refus
viendrait du marqueur absent, et le contrôle prouverait autre chose que
ce qu'il annonce. Le cluster est ensuite reconfiguré avec l'octet, et le
seul fait qui cloche est celui qu'on éprouve.

| contrôle | résultat |
| --- | --- |
| **S1** `chr(1)` | refus `socket_octets_reserves`, empreinte de rôle **inchangée**, collision prouvée réelle |
| **S2** `chr(2)` | refus `socket_octets_reserves`, empreinte de rôle **inchangée**, collision prouvée réelle |
| positif | un chemin **ordinaire** passe toujours |

### §0.2 Détecteur de mutations brutes — `CSDJ1-AUD-07-RAW-ROLE-DETECTOR-01`

Trois défauts, tous dans le contrôle censé prouver que **toute** mutation
brute est vue. Voici ce que l'ancien détecteur disait des sept fixtures du
mandat, et ce que le nouveau en dit :

| fixture | ancien | nouveau |
| --- | --- | --- |
| **D1** `q 'alter role …'` *(apostrophe)* | `SANS-OUVREUR` | `NON-GARDEE` |
| **D2** `q "alter role …"` *(guillemet)* | `NON-GARDEE` | `NON-GARDEE` |
| **D3** `q 'Alter Role …'` *(casse mixte)* | **aucune sortie** | `NON-GARDEE` |
| **D4** garde complète, puis mutation brute | `GARDEE` — **fuite d'état** | `NON-GARDEE` |
| **D5** mutation brute multi-lignes | `NON-GARDEE` | `NON-GARDEE` |
| **D6** mutation correctement gardée | `GARDEE` | `GARDEE` |
| **D7** SQL sans mutation de rôle | ignoré | ignoré |

Désormais : la recherche du mot-clé est **insensible à la casse** ; les
**deux** formes de littéral ouvrent un argument ; et l'état ne se propage
que tant qu'un argument reste **ouvert** — un appel qui se ferme sur sa
ligne ne laisse rien derrière lui. C'est ce qui ferme la fuite.

**Trouvé en écrivant les fixtures.** Un motif passé en **argument** à une
fonction awk doit être une **chaîne** : une constante `/re/` y vaut
`$0 ~ /re/`, soit 0 ou 1, et la fonction cherchait alors « 0 » dans le
texte — le détecteur ne voyait **rien du tout**. Sans les fixtures, la
correction aurait été livrée inerte. C'est exactement à cela que servent
des fixtures.

Et un jeton d'appel n'en est un que s'il est suivi d'une ouverture de
chaîne ou d'un drapeau : sinon du SQL contenant `..._probe nologin` était
pris pour un appel au client `probe`, et écrasait l'état au milieu d'un
argument gardé.

### §0.3 M8

| contrôle | défaut réinjecté | résultat |
| --- | --- | --- |
| **M8** | la défense anti-collision retirée | **détecté** — S1 et S2 **acceptent** la fausse identité et le rôle témoin passe **réellement** de `NOBYPASSRLS` à `BYPASSRLS` |

M6 et M7 sont **inchangés** et rejoués ; M1, M3, M4, M5 aussi. Sept
contrôles concluants.

---

## §00 — Le blocker du tour précédent



### §00.1 Le découpage de la liste de sockets n'était pas syntaxique

Le tour précédent avait remplacé une comparaison par **sous-chaîne** par
une **égalité d'entrée**. Le découpage, lui, restait faux :
`string_to_array(liste, ',')` coupe à **chaque** virgule, y compris
celles qui sont **dans** une entrée citée.

**Ce que PostgreSQL rend vraiment** — mesuré sur un serveur de ce poste,
pas supposé (`socket-csv-syntax.txt`) :

| configuration | ce que `SHOW` rend |
| --- | --- |
| `"<r>/foo,bar",<r>/plain` | `"<r>/foo,bar",<r>/plain` *(guillemets conservés)* |
| `"<r>/quo""te",<r>/plain` | `"<r>/quo""te",<r>/plain` *(guillemet doublé ré-encodé)* |
| `<r>/plain , <r>/trail` | `<r>/plain , <r>/trail` *(espaces conservés)* |
| `"<r>/plain,<r>/trail` *(citation non fermée)* | **le serveur refuse de démarrer** : `invalid list syntax in parameter` |

La dernière ligne est la réponse à la question du mandat : une syntaxe
mal formée **ne peut pas** sortir de `SHOW`. L'hypothèse est donc
documentée — et la garde la refuse quand même, sous le nom
`socket_liste_malformee`. Une hypothèse qu'on ne vérifie pas est une
hypothèse qu'on finit par violer.

**Le défaut allait dans les deux sens.** Sur la liste réelle du banc
d'essai :

| attendu | découpage brut | parseur |
| --- | --- | --- |
| `<r>/foo,bar` *(entrée **réelle**)* | **refusé** | accepté |
| `<r>/foo` *(fragment)* | **accepté** | refusé |
| `bar` *(fragment)* | **accepté** | refusé |
| `<r>/tr,ail` *(entrée **réelle**)* | **refusé** | accepté |
| `<r>/qu"ote` *(entrée **réelle**)* | **refusé** | accepté |

La première erreur est une fausse identité. La seconde aurait rendu le
harnais inutilisable sur un serveur réel à entrée citée — et on ne
l'aurait découvert que le jour où il aurait refusé de démarrer chez
quelqu'un.

**Le parseur.** Il ne découpe pas aveuglément. Il remplace d'abord les
guillemets doublés par une sentinelle, puis ne coupe qu'aux virgules dont
le nombre de guillemets qui précèdent est **pair** — celles qui sont hors
citation. La parité suffit : après cette substitution, les guillemets
restants sont exactement les délimiteurs, et ils alternent.

Chaque entrée est ensuite dépouillée de ses espaces **extérieurs**, de
ses guillemets encadrants — **seulement s'il y en a aux deux bouts**, car
n'en retirer qu'un est précisément ce qui transforme un fragment en
chemin plausible — puis de sa barre oblique finale, `/` restant son
propre répertoire. Les espaces **intérieurs** aux guillemets sont
conservés : ils font partie du nom, le serveur le prouve.

**Une seule implémentation.** `csdj1_identity_socket_cte()` est défini
une fois ; la garde et la démonstration de nocivité consomment la **même**
expression émise. Une démonstration conduite avec une copie prouverait la
justesse de la copie.

**Dix-huit contrôles**, chacun exigeant le refus pour la raison `socket`
et **zéro mutation** d'un rôle témoin. Le banc d'essai a cinq répertoires
de socket, dont un à **virgule**, un à **espace** et un à **barre oblique
finale**, tous trois cités : sur une liste sans guillemets, un découpage
brut et un parseur correct sont indiscernables.

| cas du mandat | résultat |
| --- | --- |
| 1 · `/tmp` attendu `/tmp` | **accepté** |
| 2 · attendu `/tm` | refus `socket`, zéro mutation |
| 3 · attendu `/tmpx` | refus `socket`, zéro mutation |
| 4 · entrée citée complète | **accepté** |
| 5 · membre simple d'une liste citée | **accepté** |
| 6 · **fragment avant la virgule citée** | refus `socket`, zéro mutation |
| 7 · **fragment après la virgule citée** | refus `socket`, zéro mutation |
| 8 · la liste entière rendue par `SHOW` | refus `socket`, zéro mutation |
| 9 · entrée citée à barre oblique finale | **accepté**, normalisée des deux côtés |
| 10 · entrée citée contenant un espace | **accepté**, préservée comme une entrée |

### §00.2 M7 — le contrôle qui rend tout cela probant

| contrôle | défaut réinjecté | résultat |
| --- | --- | --- |
| **M7** | le parseur remplacé par un découpage brut | **détecté** — le fragment devient une fausse identité **acceptée**, et le rôle témoin du banc est **réellement** muté |

M1, M3, M4, M5 et M6 sont rejoués et restent concluants. Un prédicat
qu'on ne peut pas faire échouer n'est pas un prédicat.

### §00.3 La limite signalée du détecteur, fermée

Le détecteur de mutations brutes attrapait la mutation multi-lignes, mais
une mutation **packée sur une seule ligne** lui échappait : la règle
d'ouvreur consommait la ligne avant qu'on y cherche la mutation.

Il **classe** désormais la ligne avant de mettre à jour l'ouvreur, vit
dans **un** fichier réutilisé pour s'éprouver lui-même, et quatre
fixtures l'attestent : `q "create role …;"` sur une ligne,
`csdj1_runner_test "alter role …;"` sur une ligne, la variante
multi-lignes (non-régression), et une mutation **gardée** qu'il ne doit
pas dénoncer à tort.

Les verbes SQL des fixtures sont **assemblés** et non écrits en clair :
écrits en clair, ils seraient eux-mêmes dénoncés par le détecteur qui
analyse ce fichier. Une fixture ne doit pas devenir le défaut qu'elle
éprouve. Le parseur shell n'a pas été redessiné, comme demandé.

### §00.4 Un échec non déterministe, signalé séparément

Une exécution de la suite conduite **pendant** les contrôles de mutation
a produit un onzième échec : un test DOM asynchrone qui capture encore
`Chargement…`. Relancée **seule**, la suite rend les dix identités de la
base ; le fichier rejoué seul passe 3/3, trois fois ; et il n'est pas
touché par le candidat. Les deux journaux sont fournis.
`nondeterministic-failure.txt` détaille le raisonnement.

---

## §00 — Les deux défauts du tour précédent



Les deux reproches sont justes, et tous deux sont de la même famille :
une garde qui laisse passer ce qu'elle était censée arrêter.

### §00.1 L'initialisation des rôles du TÉMOIN échappait à la garde

Le cluster témoin recevait ses attributs distinctifs — `service_role
LOGIN BYPASSRLS`, et de même pour `anon` et `authenticated` — par un
appel brut `qw`, sans le prédicat d'identité complète. L'invariant est
pourtant sans exception : **toute** mutation de rôle a lieu après la
preuve complète, marqueur et nonce compris, dans le même chemin gardé.

La raison du défaut est banale, et c'est ce qui la rend dangereuse : un
cluster « qui ne sert que de témoin » paraît ne pas compter. Un appel
brut qui ne compte pas est un appel brut qui comptera le jour où la
destination n'est plus celle qu'on croit — et ce fichier existe
précisément pour prouver qu'on ne mute jamais le mauvais serveur.

**Le témoin a donc son contrat complet** : socket attendue, port,
utilisateur, assertion superutilisateur, `data_directory`,
`config_file`, nonce d'exécution, et un marqueur en base **au nom
distinct** de celui du cluster sous test — sans quoi la preuve « le
marqueur n'existe que là » ne voudrait plus rien dire. Son
initialisation passe par `csdj1_identity_mutate`, le même prédicat
atomique que toutes les autres mutations. Aucun appel brut ne porte plus
de mutation de rôle.

**Contrats nommés.** La bibliothèque en gère désormais plusieurs, et
quatre cohabitent : `test` (cluster sous test), `temoin`, `banc` (banc
d'essai de sockets) et `test_sans_privilege` (connexion non
privilégiée). Les nommer, plutôt que sauvegarder et restaurer un contrat
global à la main autour de chaque usage, évite exactement ce qui a
produit le défaut d'origine : deux chemins presque identiques qui
divergent sans qu'on le voie.

**Un détecteur, qui aurait vu ce défaut.** Il raisonne par **commande
englobante** : une instruction de mutation vit presque toujours à
l'intérieur d'un argument sur plusieurs lignes, et un contrôle ligne à
ligne ne prouverait rien. Il suit l'ouvreur de commande le plus proche
en amont et exige qu'il soit gardé — dans **les deux** harnais, pour
`create role`, `alter role` et `drop role`, dans les deux casses. Il
vérifie aussi que les variables qui accumulent du SQL de mutation
(`RESTORE_SQL`, `PROBE_MUTATION`) ne sont consommées que par une
mutation gardée, et il **compte ce qu'il examine** : un détecteur qui ne
trouverait rien à examiner passerait pour vert.

### §00.2 Le répertoire de socket se comparait par SOUS-CHAÎNE

`strpos(unix_socket_directories, attendu) <> 0` acceptait n'importe quel
fragment. La reproduction du rapport, vérifiée ici :

| socket réelle | attendu | ancien prédicat | nouveau |
| --- | --- | --- | --- |
| `/tmp/…/lab-a` | `/tm` | **accepté** | refusé |
| `/tmp/…/lab-a` | `/tmp/…/lab-` *(préfixe)* | **accepté** | refusé |
| `/tmp/…/lab-a` | `/tmp/…` *(parent)* | **accepté** | refusé |

Une identité qui accepte un fragment n'identifie rien. Et sur un poste
où plusieurs clusters jetables vivent côte à côte sous `/tmp`, le
fragment est la règle, pas l'exception.

**La correction.** `unix_socket_directories` est une **liste** séparée
par des virgules, dont les entrées peuvent être encadrées de guillemets
doubles — c'est la syntaxe que PostgreSQL accepte pour un chemin
contenant une virgule ou un espace. Elle est donc découpée en
**entrées** (`string_to_array` + `unnest`) ; chacune est normalisée —
espaces extérieurs, guillemets, barre oblique finale, `/` restant son
propre répertoire — et l'attendu, **normalisé de la même façon** côté
shell, doit être **égal** à une entrée complète. Sans cette symétrie,
`/tmp/` et `/tmp` seraient deux répertoires différents. Un attendu non
absolu fait refuser la déclaration du contrat : un attendu vide aurait
accepté une entrée vide.

**Un banc d'essai à deux répertoires.** Le harnais crée un cluster avec
`unix_socket_directories='A,B'`. Sans lui, rien ne distingue « une
entrée complète » de « la liste ». Onze contrôles :

| attendu | verdict |
| --- | --- |
| entrée exacte (membre 1) | **accepté** |
| entrée exacte (membre 2) | **accepté** |
| entrée avec barre oblique finale | **accepté** |
| préfixe d'une entrée | refus `socket`, zéro mutation |
| entrée + un caractère | refus `socket`, zéro mutation |
| répertoire parent | refus `socket`, zéro mutation |
| sous-répertoire d'une entrée | refus `socket`, zéro mutation |
| suffixe d'une entrée | refus `socket`, zéro mutation |
| la liste entière | refus `socket`, zéro mutation |
| **`/tmp` contre `/tm`** | refus `socket`, zéro mutation |
| **`/tmp` contre `/tmpx`** | refus `socket`, zéro mutation |

Les deux dernières lignes sont la reproduction littérale du rapport.

**La nocivité est démontrée, pas déclarée.** Pour trois attendus
partiels, le harnais montre en lecture seule que l'ancien prédicat les
acceptait et que le nouveau les refuse.

### §00.3 Contrôle de sensibilité — M6

| contrôle | défaut réinjecté | résultat |
| --- | --- | --- |
| **M6** | l'égalité exacte remplacée par une sous-chaîne | **détecté** — « préfixe d'une entrée » et « répertoire parent » sont **acceptés à tort**, et le rôle témoin du banc est **réellement** muté (`NOBYPASSRLS → BYPASSRLS`) |

M1, M3, M4 et M5 sont rejoués et restent concluants. Un prédicat qu'on
ne peut pas faire échouer n'est pas un prédicat.

### §00.4 Un incident, réparé au passage

Un commentaire du heredoc de la garde contenait des accents graves, que
le shell exécutait comme des commandes : le harnais imprimait `strpos:
command not found` à chaque nettoyage. Sans conséquence sur le SQL émis,
mais un harnais qui bruite est un harnais qu'on cesse de lire.

---

## §000 — Les deux blockers du tour -2



### §000.1 CSDJ1-AUD-PYTHON-01 (P1) — l'oracle n'était plus un oracle

Le reproche est juste, et il est plus sérieux qu'un défaut de
comportement : `resolve_wall` **reproduisait l'algorithme des deux
implémentations qu'il juge** — échantillonnage de décalages,
reconstruction d'instants candidats.

Trois implémentations qui partagent une hypothèse ne se vérifient pas
mutuellement. Elles se trompent **ensemble**, et leur accord n'établit
rien. L'audit a d'ailleurs vérifié Paris, Lord Howe et les autres zones
obligatoires avec son propre oracle, et n'a trouvé **aucune** erreur
fonctionnelle : le défaut était bien dans la **preuve**.

Une preuve qui ne prouve rien est plus dangereuse qu'une absence de
preuve, parce qu'on s'y fie.

**La méthode, désormais.** L'oracle ne calcule plus aucun décalage et ne
construit plus aucun candidat. Il délègue la sémantique des fuseaux à la
bibliothèque standard, par le mécanisme que PEP 495 a créé pour
exactement ce problème. Pour une heure murale locale `L` dans la zone
`Z` :

1. attacher `Z` à `L` avec `fold=0` — la **première** lecture possible ;
2. attacher `Z` à `L` avec `fold=1` — la **seconde** ;
3. convertir chaque lecture en instant UTC (`astimezone`) ;
4. **reconvertir** chaque instant vers `Z` — l'aller-retour ;
5. ne garder que les instants dont l'heure murale relue vaut
   exactement `L` ;
6. dédupliquer les instants UTC égaux.

Le classement est le **cardinal** : zéro → `nonexistent`, un →
`valid_unique`, deux → `ambiguous`.

**Pourquoi c'est correct sans hypothèse de durée.** En heure normale,
`fold=0` et `fold=1` désignent le même instant : la déduplication en
laisse un. Sur un recul d'horloge, ils désignent deux instants distincts
qui relisent tous deux `L` — que le recouvrement fasse soixante minutes
(Europe/Paris) ou **trente** (Australia/Lord_Howe), le cardinal ne change
pas. Sur un saut d'horloge, PEP 495 fait répondre `fold=0` avec le
décalage d'**avant** la transition et `fold=1` avec celui d'**après** ;
l'un et l'autre relisent une heure murale décalée, et l'aller-retour les
élimine tous les deux.

L'étape 4 est le cœur : on ne fait jamais confiance à une conversion, on
vérifie qu'elle rend ce qu'on avait demandé.

**Le résultat qui mérite d'être dit.** Les **48 cas d'offres sont
inchangés, octet pour octet**, après le changement de méthode. La méthode
a changé, les attendus non. C'est exactement ce que vaut l'accord des
trois — et c'est ce qu'on ne pouvait pas affirmer au tour précédent.

**38 points de classement.** La fixture porte désormais, à côté de ses
cas d'offres, des points de **classement** dont les attendus viennent de
cet oracle. Ils sont rejoués par `resolveWallTime`
(`[ORACLE-3]`) et par `public.checkout_wall_time_status` (harnais
`[6o]`), qui procèdent tous deux autrement. **Zéro divergence.** Zones :
Europe/Paris, Australia/Lord_Howe, UTC, Pacific/Kiritimati,
America/Los_Angeles, America/New_York, Pacific/Chatham, Asia/Kathmandu.

| zone / instant | classement |
| --- | --- |
| `Europe/Paris 2026-03-29 02:00 / 02:10 / 02:30 / 02:59` | `nonexistent` |
| `Europe/Paris 2026-03-29 01:59` et `03:00` | `valid_unique` |
| `Europe/Paris 2026-10-25 02:00 / 02:30 / 02:59` | `ambiguous` |
| `Australia/Lord_Howe 2026-04-05 01:30 / 01:45 / 01:59` | `ambiguous` |
| `Australia/Lord_Howe 2026-04-05 01:00` et `02:00` | `valid_unique` |
| `Australia/Lord_Howe 2026-10-04 02:00 / 02:10 / 02:29` | `nonexistent` |
| `Australia/Lord_Howe 2026-05-03 01:45` | `valid_unique` |

**L'indépendance est démontrée, pas déclarée.** Le mandat est explicite :
ne pas s'en remettre aux seules vérifications de source. Trois
classificateurs **délibérément faux** sont donc confrontés à l'oracle —
et chacun reproduit une erreur réellement commise, ou réellement
tentante, dans l'histoire de ce lot :

| classificateur faux | l'oracle le contredit sur |
| --- | --- |
| ambiguïté cherchée « à ±1 heure » *(le défaut du re-audit précédent)* | `Australia/Lord_Howe 2026-04-05 01:45` |
| confiance à la normalisation du moteur, sans aller-retour *(le défaut du premier candidat)* | `Europe/Paris 2026-03-29 02:30` |
| sonde unique au point demandé | `Europe/Paris 2026-10-25 02:30` |

`[ORACLE-5]` exige de plus que chacun soit **juste ailleurs** : un
classificateur faux partout serait trouvé le premier jour et ne dirait
rien de la finesse de l'oracle. C'est ce qui rend ces défauts dangereux
dans la vraie vie, et c'est donc cela qu'il faut savoir détecter.

`[ORACLE-2]` ferme l'autre bout : les deux implémentations **jugées**
doivent continuer d'échantillonner. Si elles migraient un jour vers la
méthode des plis, les trois convergeraient de nouveau et `[ORACLE-1]`
resterait vert sans plus rien garantir.

### §000.2 CSDJ1-AUD-07 (P1) — l'identité de destination était partielle

Le nettoyage vérifiait quatre faits avant de muter des rôles : socket,
port, utilisateur, superutilisateur. Il **omettait** `data_directory`,
`config_file` et le marqueur d'exécution. Deux clusters différents
peuvent présenter cette identité partielle — même numéro de port, même
nom d'utilisateur, même motif de nommage de socket — et la requête rendait
le **même** résultat que le marqueur fût changé ou retiré. La preuve ne
liait donc pas le serveur à **cette** exécution.

La cause profonde n'était pas la faiblesse d'un contrôle : c'était
l'**existence de deux** contrôles, un à la mise en place et un autre au
nettoyage, subtilement différents. C'est la forme même du défaut.

Il n'y en a donc plus qu'un, dans une bibliothèque sourcée par les deux
harnais : `supabase/tests/csdj1-cluster-identity.sh`.

**Les huit faits.** Aucune destination réseau (`inet_server_addr()` vaut
`NULL`) ; la socket attendue figure dans `unix_socket_directories` ; le
port ; l'utilisateur ; le statut superutilisateur ; le `data_directory`
**exact** ; le `config_file` **exact** ; un **marqueur** en base portant
le nonce de cette exécution. Un seul qui échoue, et rien n'est muté.

L'ordre compte : le statut superutilisateur est vérifié **avant** les
réglages qui l'exigent, sinon un défaut de privilège se présenterait
comme une erreur de permission et non comme un refus **nommé**. Un test
structurel fixe cet ordre.

**Une session, une transaction.** Prouver puis muter en deux connexions
laissait un intervalle pendant lequel la destination pouvait changer. La
garde et la mutation tiennent donc dans un **bloc `DO` unique**, dont
l'exception annule tout. Le marqueur est lu par la session même qui
mutera.

**Le marqueur est en base, pas sur le disque.** Un fichier témoin
prouverait que le *système de fichiers* est le bon, pas que le *serveur
joint* est le bon. Le marqueur est une table de ce cluster, lue en SQL :
aucun autre serveur ne peut la présenter, quel que soit son port, son
utilisateur ou le nom de sa socket. Il porte un nonce unique par
exécution (étiquette + 8 octets de `/dev/urandom`), le harnais **refuse**
si une table de ce nom existe déjà — il ne peut pas prouver qu'il en est
le propriétaire — et il n'est retiré que du serveur qui vient de prouver
son identité.

**Tous les chemins qui mutent y passent**, la mise en place comprise.
Les rôles globaux ne sont plus créés depuis l'amorçage d'une base
jetable — un marqueur logé dans `postgres` n'y aurait pas été visible —
mais au niveau du cluster, par le point de passage commun. La
restauration du nettoyage est **une seule transaction gardée** : ou les
trois rôles reviennent à leur état d'origine, ou aucun ne bouge ; une
restauration à moitié faite serait un état que personne n'a jamais
décidé. Et il n'existe **aucun chemin de repli plus faible** : en cas de
refus, on ne réessaie pas autrement.

**Dix contrôles négatifs.** Un prédicat qu'on ne peut pas faire échouer
n'est pas un prédicat. On fausse donc un seul fait à la fois, et on
exige, pour chacun, le refus **pour la bonne raison** — un refus de
connexion pris pour un refus d'identité ne prouverait pas la même
chose — et **zéro mutation** d'un rôle témoin :

| fait faussé | refus | rôle témoin |
| --- | --- | --- |
| `data_directory` | `data_directory` | intact |
| `config_file` | `config_file` | intact |
| **marqueur retiré** | `marqueur_absent` | intact |
| **marqueur changé** | `nonce` | intact |
| nonce attendu faux | `nonce` | intact |
| port | `port` | intact |
| utilisateur | `current_user` | intact |
| non superutilisateur | `is_superuser` | intact |
| destination réseau (témoin) | `destination_reseau` | intact |
| socket attendue | `socket` | intact |

Les deux lignes en gras sont la **reproduction littérale** du constat de
l'audit.

Un onzième contrôle, **positif**, exige que le chemin nominal mute
toujours, effet observé sur le rôle témoin. C'est l'exigence explicite du
mandat : *« A harness that always aborts is not a PASS. »*

**PGHOSTADDR** reste refusé par son nom, parmi 27 variables, sans que sa
valeur paraisse jamais — `harness-refusal-redirect-var.txt` : code 2,
« aucune mutation n'a été tentée », zéro occurrence de la valeur. Et la
section `[F]` continue de démontrer que la menace est réelle : sans
isolation la connexion aboutit **au témoin**, sous `env -i` au cluster
sous test.

### §000.3 Contrôles de mutation

| contrôle | défaut réinjecté | résultat |
| --- | --- | --- |
| **M1** | un `env -i` retiré devant un appel client | **détecté** — « appel non isolé » |
| **M2** | — | nocivité de `PGHOSTADDR` prouvée par démonstration directe (`[F]`), non par mutation |
| **M3** | instantané de rôle en `::text` comparé à `'t'` *(défaut d'AUD-06)* | **détecté** — 13 échecs décrivant `LOGIN → NOLOGIN`, `BYPASSRLS → NOBYPASSRLS` |
| **M4** | le **marqueur** retiré du prédicat — *la preuve partielle que l'audit a trouvée* | **détecté** — « marqueur retiré » et « marqueur changé » acceptent alors la mutation, et le rôle témoin est **réellement** muté |
| **M5** | `data_directory` et `config_file` retirés du prédicat | **détecté** — les deux contrôles négatifs correspondants acceptent la mutation |

M4 est le contrôle qui compte pour ce tour : sans lui, dix contrôles
négatifs verts ne diraient pas s'ils savent voir quoi que ce soit.

---

## §0000 — Les deux blockers du tour -3



### §0000.1 CSDJ1-AUD-02 (P1) — la validation d'heure murale était incomplète

Le re-audit delta a produit trois reproductions, et deux reproches
distincts se cachaient derrière.

| reproduction | comportement fautif |
| --- | --- |
| `Europe/Paris 2026-03-29` fenêtre `01:30–02:30` | offerte, **fin comprise**, alors que 02:30 n'existe pas |
| `Europe/Paris 2026-03-29` fenêtre `01:30–03:30` | pouvait exposer des points de grille inexistants, **au choix du client** |
| `Australia/Lord_Howe 2026-04-05 01:45` | traitée comme valide alors qu'elle est **ambiguë** |

**Premier reproche : une hypothèse de taille.** La version précédente
cherchait l'ambiguïté en comparant à **plus ou moins une heure**. Lord
Howe recule de **trente** minutes : 01:45 y est vécue deux fois, et ce
test ne pouvait pas la voir. L'audit l'a dit en une phrase — « DST
transitions are NOT always exactly 60 minutes » — et c'est la phrase qui
condamne toute la méthode, pas seulement sa constante.

La classification n'émet donc plus **aucune** hypothèse sur la durée
d'une transition :

1. lire le décalage UTC en vigueur à cinq sondes autour de l'instant
   naïf — `−1 jour`, `−4 h`, `0`, `+4 h`, `+1 jour` — et ne retenir que
   les décalages **distincts** ;
2. pour chaque décalage distinct, construire un instant candidat
   `heure murale − décalage` ;
3. ne garder que les candidats qui, **re-rendus dans le fuseau**,
   redonnent exactement la date et la minute demandées ;
4. **compter** : zéro candidat → `nonexistent`, un → `valid_unique`,
   deux ou plus → `ambiguous`.

L'étape 3 est ce qui interdit la normalisation silencieuse : on ne fait
jamais confiance au résultat d'une conversion, on vérifie l'aller-retour.
L'étape 4 est ce qui remplace l'hypothèse : la réponse est un
**comptage**, et aucune durée n'y intervient. `[AUD02-SQL-2]` interdit
structurellement toute constante d'une heure (`1 hour`, `3600`,
`interval '01:00'`, `hours => 1`, `3_600_000`) dans la décision, des
deux côtés.

Le classement est un **catalogue fermé de trois valeurs**,
`public.checkout_wall_time_statuses()`, miré par `[MIRROR-9]`. Le statut
`ok` de la version précédente est devenu `valid_unique` : « ok » ne
disait pas *ce qui* était vrai. Il n'était exposé par aucune surface
publique, donc rien ne change pour un client.

**Second reproche : une hypothèse de suffisance.** Valider le seul
**début** laissait passer une fin inexistante et des points de grille
inexistants. `CSDJ-V1-OCCURRENCE-ALL-OR-NOTHING-01` : une occurrence est
exposée **en entier ou pas du tout**. Début, fin et **chaque** point de
la grille sélectionnable doivent être `valid_unique` ; un seul point non
univoque et l'occurrence disparaît **ce jour-là**. Aucune heure de
remplacement n'est inventée.

Le refus porte sur l'**occurrence d'une date**, jamais sur la
configuration : la même fenêtre reste valide les 364 autres jours. C'est
pourquoi il ne peut pas être prononcé à l'écriture — et `[AUD02-10]` le
prouve.

Tous les points de la grille sont validés, pas seulement la part encore
réalisable : sur une date ordinaire, le client pourrait choisir
n'importe lequel d'entre eux.

**Résultat sur Lord Howe** (`wall-time-three-way-agreement.txt`) :

| instant | classement |
| --- | --- |
| `2026-04-05 01:00` | `valid_unique` |
| `2026-04-05 01:30` | `ambiguous` |
| `2026-04-05 01:45` | `ambiguous` ← le cas exact du re-audit |
| `2026-04-05 01:59` | `ambiguous` |
| `2026-04-05 02:00` | `valid_unique` |
| `2026-10-04 02:00 / 02:10 / 02:29` | `nonexistent` (saut de trente minutes) |
| `2026-05-03 01:45` | `valid_unique` — la politique ne **sur-refuse** pas |

Côté offres : `aud02-lord-howe-autumn-30min-ambiguous` n'expose plus que
`t0100` et `t0200` — **`t0145` a disparu**.

**Accord à trois voies.** Les trois implémentations — Python
(`resolve_wall`), TypeScript (`resolveWallTime`) et le SQL du lot
(`checkout_wall_time_status`, extraite **littéralement** du fichier et
créée dans un cluster jetable) — s'accordent sur **38 points de
classification** et sur les **48 cas de fixture**, avec **zéro**
divergence. Zones couvertes : Europe/Paris, Australia/Lord_Howe (30 min),
UTC (aucune transition), Pacific/Kiritimati (UTC+14),
America/Los_Angeles et America/New_York (décalages négatifs),
Pacific/Chatham et Asia/Kathmandu (décalages à 45 minutes de l'heure).

### §0000.2 CSDJ1-AUD-07 (P1) — le harnais de rôles n'était pas isolé

`q()` héritait des variables libpq de l'environnement appelant.
**`PGHOSTADDR` l'emporte sur un `-h` explicite** : le harnais pouvait
donc muter les rôles **globaux** d'un autre serveur que celui que le
verrou de sûreté avait constaté — et ne s'en apercevoir qu'après.

Trois défenses, dans cet ordre.

**1. Refus par le nom.** 27 variables de routage, refusées dès le
démarrage avec le code 2 : `PGHOST`, `PGHOSTADDR`, `PGPORT`,
`PGDATABASE`, `PGUSER`, `PGPASSWORD`, `PGPASSFILE`, `PGSERVICE`,
`PGSERVICEFILE`, `PGSYSCONFDIR`, `PGCLUSTER`, `PGREQUIRESSL`,
`PGSSLMODE`, `PGSSLROOTCERT`, `PGSSLCERT`, `PGSSLKEY`, `PGOPTIONS`,
`PGCONNECT_TIMEOUT`, `PGTARGETSESSIONATTRS`, `PGDATA`, `DATABASE_URL`,
`POSTGRES_URL`, `POSTGRESQL_URL`, `PG_URL`, `SUPABASE_DB_URL`,
`SCANYM_DB_URL`, `SCANYM_DATABASE_URL`. Puis un balayage défensif retire
toute autre `PG*` héritée, pour qu'un oubli de la liste ne subsiste pas.

Le refus **nomme la variable et jamais sa valeur** : une valeur peut
être un secret. `harness-refusal-redirect-var.txt` le montre, et chaque
vecteur hostile vérifie que la valeur n'apparaît nulle part dans la
sortie.

**2. Isolation.** Chaque appel client s'exécute en
`env -i PATH=<sûr> HOME=<jetable>`, avec un binaire résolu en chemin
**absolu** (un binaire résolu par le `PATH` est un binaire que le `PATH`
peut remplacer) et une destination entièrement explicite
`-h/-p/-U/-d`. `[E]` le vérifie **structurellement** : il reconstitue
les lignes **logiques** du fichier — continuations recollées, car
`env -i … \` suivi de `"$PSQL" …` est une seule commande et un contrôle
ligne à ligne la déclarerait faussement nue — et compte ce qu'il examine,
parce qu'un détecteur qui ne trouve rien passerait pour vert.

**3. Preuve d'identité, immédiatement avant chaque mutation.** Sept
faits comparés : socket unix (donc **aucune** destination réseau),
`data_directory`, `config_file`, port, `current_user`, `is_superuser`, et
un **nonce** que seul le cluster créé par ce fichier porte. Si la preuve
échoue : **abandon avant mutation**. La même preuve adressée au cluster
témoin échoue — elle **discrimine**.

Le harnais principal ferme le même trou côté nettoyage : destination
changée ⇒ `RESTAURATION DE RÔLES ABANDONNÉE`, plutôt que muter le mauvais
serveur. Un rôle non restauré est un désagrément ; un rôle muté sur le
mauvais serveur est un dégât.

**Un défaut trouvé dans la preuve elle-même.** `pg_catalog.current_user`
n'est pas une fonction qualifiable : c'est un **constructeur du
parseur**, lu comme la colonne `current_user` d'une table `pg_catalog`,
et la requête échouait (`missing FROM-clause entry for table
pg_catalog`, vérifié empiriquement dans un cluster jetable). Même
famille que `coalesce`, `nullif`, `extract` et `unnest` multi-tableaux.

Une preuve **cassée** se comporte comme une preuve **échouée** : elle
abandonne la restauration. Fermé, donc sans danger — mais **muet**, et
le chemin de restauration aurait été mort sans que rien ne le dise.
`[A]` exige désormais qu'une exécution **nominale** ne l'abandonne
jamais, et le contrôle de mutation M4 prouve que cette garde voit une
preuve cassée.

**La menace est démontrée, pas déclarée.** Un refus qui protège d'un
danger inexistant ne prouve rien. Le fichier crée donc un **cluster
témoin** qui écoute en TCP sur `127.0.0.1` au **même numéro de port** que
le cluster sous test — lequel n'écoute **aucun** TCP, n'occupant que sa
socket privée. La redirection est ainsi réellement possible, et `[F]` la
reproduit en **lecture seule** :

| appel | destination atteinte |
| --- | --- |
| `PGHOSTADDR=127.0.0.1 PGPORT=<port>` + `-h <socket privée>` | **le témoin** |
| le même, sous `env -i` | le cluster sous test |

Onze variables hostiles sont ensuite éprouvées une par une, le harnais
étant relancé **en enfant** avec la variable pointant vers le témoin.
Pour chacune : refus avec le code 2, le refus **nomme** la variable, la
valeur n'apparaît **nulle part**, et le témoin subit **zéro** mutation.
Puis le vecteur complet `PGHOSTADDR + PGPORT` ensemble. Puis un
**contrôle positif** : un environnement propre ne déclenche pas ce refus
et atteint bien le cluster sous test — sans quoi un harnais qui refuserait
tout passerait pour protégé.

**87 preuves, 0 échec** (`harness-role-restoration.txt`).

### §0000.3 Contrôles de mutation, et AUD-06 re-prouvé

Un harnais vert ne prouve rien si le défaut qu'il interdit peut être
réinjecté sans qu'il échoue.
`supabase/tests/checkout-scheduling-foundation-v1-mutation-controls.sh`
est **versionné** pour que l'audit le rejoue
(`harness-mutation-controls.txt`) :

| contrôle | défaut réinjecté | résultat |
| --- | --- | --- |
| **M1** | un `env -i` retiré devant un appel `psql` | **détecté** — « appel non isolé », code 1 |
| **M2** | — | la nocivité de `PGHOSTADDR` est prouvée par **démonstration directe** en lecture seule (`[F]`), non par mutation : muter le harnais aurait supprimé son propre garde-fou de récursion et prouvé moins |
| **M3** | l'instantané de rôle en `::text` comparé à `'t'` — le défaut d'**AUD-06** | **détecté** — 13 échecs décrivant `LOGIN → NOLOGIN` et `BYPASSRLS → NOBYPASSRLS` |
| **M4** | preuve d'identité tardive cassée | **dénoncée** — « la restauration a été ABANDONNÉE sur le cluster désigné » |

`harness-role-restoration-mutation.txt` est conservé : c'est le contrôle
de mutation du tour **précédent**, conduit sur le harnais d'alors. M3 le
reconduit sur le harnais **réécrit**, et c'est M3 qui fait foi pour ce
candidat.

M3 est la réponse à l'exigence du mandat : **AUD-06 reste clos**
après la correction d'isolation d'AUD-07. Les quatre combinaisons
`LOGIN × BYPASSRLS` et le rôle initialement **absent** sont restaurés
exactement, en mode cluster **désigné** — le seul où la restauration a
des conséquences durables — et le harnais voit encore le défaut quand on
le réinjecte.

### §0000.4 Discipline de portée

Aucun redesign. Aucun contrat déjà clos modifié, à une exception près et
strictement nécessaire : l'ajout du catalogue des trois statuts d'heure
murale et le renommage de `ok` en `valid_unique`, qu'aucune surface
publique n'expose. CSDJ-2 **non commencé**.

Le défaut d'isolation d'environnement existe **aussi** dans
`supabase/tests/merchant-customer-communications-v1-check.sh`, dont ce
harnais est dérivé. **Non corrigé ici** : le mandat interdit d'élargir la
portée. Signalé dans `aud06-same-defect-elsewhere.txt`.

---

## §1 — Les six blockers, et ce qui les ferme

### CSDJ1-AUD-01 (P1) — le délai filtrait des dates, pas des offres

Le délai de préparation n'était appliqué qu'à la **date de départ**. Un
créneau 09:00–11:00 avec 120 minutes de délai restait donc proposé à
15:00 : la date passait le filtre, et personne ne regardait l'offre.

`CSDJ-V1-OFFER-START-INSTANT-01` : chaque offre est désormais comparée
en **instant** à `max(now + lead_time_minutes, plancher de (today +
min_lead_days) dans le fuseau)`. Une offre dont le **début** tombe avant
est écartée — y compris un créneau déjà commencé, qui n'est plus
honorable en entier. Une date dont toutes les offres sont écartées cesse
d'être éligible.

Aucune offre n'est fabriquée. Pour `time_within_window`, le début est
**avancé** le long de la grille de granularité du commerçant jusqu'au
premier point utilisable, et la fenêtre disparaît si la grille en sort :
c'est la part encore utilisable d'une fenêtre existante, pas un créneau
nouveau. La grille reste ancrée sur le début **configuré**, pour rester
celle que le commerçant a décrite.

Nouveau motif `no_offer_in_horizon`, distinct de `horizon_exhausted` :
dans le premier cas des dates étaient ouvertes et ce sont les **offres**
qui ne tenaient plus — on desserre le délai ou on attend ; dans le
second la première date possible est au-delà de l'horizon — on allonge
l'horizon. Les confondre livrerait au commerçant un refus qu'il ne sait
pas corriger.

### CSDJ1-AUD-02 (P1) — heure murale inexistante ou ambiguë

Le serveur acceptait `Europe/Paris 2026-03-29 02:10–02:50`, un intervalle
qui **n'a pas eu lieu** : PostgreSQL le normalisait en silence. Une
normalisation de moteur n'est pas une politique commerciale.

`CSDJ-V1-WALL-TIME-FAIL-CLOSED-01` : **refus fermé des deux cas** —
l'heure inexistante du saut de printemps et l'heure ambiguë du recul
d'automne. Pour une heure ambiguë, « nous vous livrons à 02:30 »
désignerait deux instants distants d'une heure, et personne n'aurait
choisi lequel. Un refus, lui, est visible et corrigeable.

Deux autorités nouvelles : `checkout_wall_time_status()` classe
`valid_unique` / `nonexistent` / `ambiguous` (nommé `ok` au tour
précédent, voir §000.1), et `checkout_wall_time_instant()`
rend `NULL` dès que l'heure n'est pas univoque. Ce `NULL` est un
**refus**, jamais une absence de valeur — c'est pour cela qu'il n'y a
pas de repli. Miroir TypeScript : `resolveWallTime()`.

Le refus porte sur l'**occurrence** d'une date, pas sur la
configuration : une fenêtre 02:00–03:00 reste valide les 364 autres
jours de l'année, et c'est précisément pourquoi ce refus ne peut pas
être prononcé à l'écriture.

### CSDJ1-AUD-03 (P1) — mode de vente désactivé encore exposé

`restaurant_sale_modes.enabled = false`, et la lecture publique
projetait quand même : l'activation n'était vérifiée qu'indirectement,
pour la livraison, via l'autorité de tarification.

`CSDJ-V1-MODE-ENABLED-GATE-01` : la garde précède **toute** projection,
pour tous les modes. La réponse est celle d'une absence,
**volontairement indiscernable** de « aucune planification » et de
« planification désactivée » : un statut distinct ferait de la surface
publique un moyen de sonder la configuration d'un commerçant. Ni
fuseau, ni politique, ni granularité, ni date, ni offre ne traversent.

### CSDJ1-AUD-04 (P2) — précision perdue à la sérialisation

Un créneau `09:00:01–09:00:59` se publiait « 09:00–09:00 » tout en
restant disponible : une offre de **durée nulle** affichée comme
réservable.

`CSDJ-V1-MINUTE-PRECISION-01` : toute heure de configuration est à la
minute, secondes exactement `00`. Une valeur sous-minute est **refusée,
jamais tronquée** — tronquer était le défaut, parce que la configuration
disait une chose et la projection une autre. Contrainte sur **chaque**
colonne `time` des trois tables, refus nommé `CSDJ1_SUBMINUTE_TIME` dans
la RPC d'écriture, et `parseScheduleTime` qui refuse au lieu d'arrondir.

`CSDJ-V1-NO-24H-01` : `24:00` est refusé explicitement. Une fin de
journée se déclare `23:59`, sinon chaque comparaison, chaque formatage
et chaque calcul d'instant devrait connaître ce cas particulier — et il
suffit d'un endroit qui l'oublie pour décaler une date d'un jour.

### CSDJ1-AUD-05 (P2) — anti-dérive qui acceptait les sosies

Le pré-vol cherchait les colonnes par **sous-chaîne** dans le texte de
la signature : `not_eligible` contient « eligible », `not_block`
contient « block ». Le lot s'appliquait, puis échouait en `42703` à la
première lecture — c'est-à-dire en production, et non à l'application.

`CSDJ-V1-RESOLVER-EXACT-SHAPE-01` : vérification par **introspection du
catalogue**. Nom exact et type exact de chaque colonne de sortie, lus
dans `pg_proc` via `unnest(proargnames, proargmodes, proallargtypes)` en
ne retenant que les colonnes de mode `t`. Plus l'exigence d'une
surcharge **unique**, sans laquelle le contrôle serait ambigu. Aucune
heuristique textuelle.

Cinq mutations prouvent le refus — sosie par sous-chaîne, colonne
renommée, mauvais type, colonne absente, surcharge supplémentaire — et
chacune vérifie en outre qu'**aucun objet du lot n'a été créé** avant le
refus. Un **contrôle positif** prouve qu'une forme conforme s'applique :
sans lui, un garde qui refuserait tout passerait pour un garde correct.

### CSDJ1-AUD-06 (P2) — restauration de rôles corrompue

`boolean::text` rend « true », jamais « t » — « t » est la forme de
l'affichage **aligné** de psql. La capture employait `::text` et la
comparaison testait « t » : elle échouait toujours, et la branche de
repli restaurait `NOLOGIN NOBYPASSRLS`. Invisible sur un cluster jetable
détruit juste après ; **durable** sur un cluster désigné par
l'opérateur.

L'instantané encode désormais `1`/`0`, la restauration compare à
`1`/`0`, et le verrou de sûreté n'accepte que les quatre instantanés
bien formés : un instantané d'une autre forme fait **refuser**
l'exécution plutôt que muter un cluster non restaurable.

Un harnais dédié prouve la restauration **exacte** des quatre
combinaisons `LOGIN × BYPASSRLS` sur les trois rôles, en mode **cluster
désigné** — le seul où la restauration a des conséquences durables —
plus le cas du rôle initialement absent.

Et un **contrôle de mutation** : le défaut réinjecté dans une copie hors
dépôt produit **13 échecs** décrivant exactement la corruption que
l'audit a décrite (`LOGIN → NOLOGIN`, `BYPASSRLS → NOBYPASSRLS`). Sans
ce contrôle, 22 preuves vertes ne diraient pas si le harnais sait
détecter quoi que ce soit.

**Le même défaut existe ailleurs** : `merchant-customer-communications-v1-check.sh`
(lignes 340 et 376), d'où ce harnais a été dérivé. Non corrigé ici — le
mandat interdit d'élargir la portée — et signalé dans
`aud06-same-defect-elsewhere.txt` pour planification.

---

## §2 — Observations étroites closes

**Zéro UUID réservé.** La sentinelle interne de « portée de mode » est
désormais interdite comme `fulfillment_rule_id` : contrainte
`rfs_rule_id_not_sentinel` et refus nommé `CSDJ1_RESERVED_RULE_ID`. Sans
cela, « portée de mode » et « portée de cette règle-là » deviendraient
indiscernables le jour où une règle porterait cette valeur.

**Horizon 0.** L'horizon accepte désormais `0`, « aujourd'hui
seulement » : c'est un cas commerçant réel, et la forme minimale dans
laquelle se reproduit AUD-01.

---

## §3 — Observations laissées ouvertes, et pourquoi

**`display_order` n'ordonne rien.** L'ordre des offres est celui des
heures de début : déterministe, et indépendant d'une saisie. La colonne
est réservée à l'éditeur back-office, hors CSDJ-1. Aucun invariant v1
n'est violé — le redesigner serait élargir la portée.

**Créneaux nommés qui se chevauchent.** Autorisé, et voulu : « matin »
09:00–13:00 et « midi » 12:00–14:00 sont une offre commerciale
légitime. Les **fenêtres**, elles, ne peuvent pas se superposer, parce
qu'elles décrivent une ouverture et non un choix. Aucun invariant v1
n'est violé.

**Coordination du retour arrière avec CSDJ-3.** Le point d'extension
existe déjà : le retour **refuse** de passer si
`public.order_fulfillment_schedule_snapshot` est présente, avec
`SCANYM_ROLLBACK_REFUSED`. CSDJ-3 n'est pas implémenté.

---

## §4 — Preuve de la fixture Python

L'audit a eu raison : une preuve « indépendante » dont la source n'est
pas livrable n'est pas vérifiable. La revendication est **maintenue** et
désormais vérifiable.

| | |
|---|---|
| source | `tests/fixtures/build-checkout-scheduling-cases.py`, versionnée au dépôt |
| commande | `python3 -I tests/fixtures/build-checkout-scheduling-cases.py` |
| journal | `fixture-generation.log` |
| Python | 3.13.16 (CPython) |
| base de fuseaux | **tzdata 2026c** (`/usr/share/zoneinfo`, paquet système `2026c-0ubuntu0.24.04.1`) |

Relancer le générateur reproduit `checkout-scheduling-cases.json` **à
l'octet** — vérifié par comparaison d'empreinte avant/après
(`sha256 c266e5ce…`). Un test structurel `[FIXTURE-SOURCE-1]` vérifie
qu'il ne **lit** ni n'**exécute** aucune des deux implémentations qu'il
juge, et qu'il tire ses fuseaux de la bibliothèque standard ;
`[ORACLE-8]` va plus loin et vérifie qu'il ne **dispose** d'aucun
mécanisme pour le faire (`subprocess`, `importlib`, `exec`, `urllib`…) et
que tous ses imports sont ceux de la bibliothèque standard.

La fixture porte **48 cas d'offres** et **38 points de classement**.
L'indépendance de la **méthode** de l'oracle — ce que ce paquet-ci a
corrigé — est traitée en §0.1 : la source livrable ne suffisait pas, il
fallait encore que l'oracle ne refasse pas le calcul de ceux qu'il
juge.

---

## §5 — Résultats mesurés

| Vérification | Résultat |
|---|---|
| tests ciblés CSDJ-1 | **155 / 0** (10 + 78 + 59 + 8) |
| régressions exigées | **285 / 0** (12 fichiers) |
| harnais PostgreSQL du lot | **156 preuves / 0 échec** (19 sections) |
| harnais d'isolation et de rôles | **183 preuves / 0 échec** (`[A]`–`[H]`) |
| contrôles de mutation M1/M3/M4/M5/M6/M7/**M8** | **7 concluants / 0 manquant** |
| contrôles de socket | **18**, plus **S1/S2** d'octets réservés |
| fixtures du détecteur | **D1–D7**, toutes correctes |
| contrôles négatifs d'identité | **10**, zéro mutation |
| oracle Python, fixture, résolveur, SQL du lot | **NON TOUCHÉS** (`git diff` vide) |
| TypeScript | **0 diagnostic** |
| build | **EXIT 0**, 39 routes, aucune ajoutée |
| suite complète, base `412dbb5` | 4768 / 10 |
| suite complète, cinquième remédiation `7420bec` | 4931 tests, 4921 / 10 |
| suite complète, ce candidat `8dafd78` | **4933 tests, 4923 / 10** |
| identités d'échec | **0 apparue, 0 disparue** |

La comparaison porte sur les **identités**. Les jeux de la **base**, du
**cinquième candidat** et de **celui-ci** sont **octet-identiques** (md5
`d788b58cd63f6c59be1b1195c76bc1c5`). Le delta de **+2** réussites est
exactement le nombre de tests ajoutés : `[AUD07-SQL-7]` et
`[AUD07-SQL-8]`.

**Aucun échec intermittent ce tour** : la suite a tourné machine au
repos, les contrôles de mutation étant terminés. L'échec documenté au
tour précédent (`nondeterministic-failure.txt`) ne s'est pas reproduit.

---

## §6 — Ce qui n'a pas régressé

Le quatrième re-audit delta a déclaré clos AUD-PYTHON-01, AUD-02,
AUD-03, AUD-04, AUD-05 et AUD-06, plus treize domaines à préserver. Tous
sont conservés et **re-prouvés** après les deux corrections :

| domaine clos | preuve de non-régression |
| --- | --- |
| AUD-PYTHON-01 | oracle **intact** (plis, aller-retour) ; fixture reproduite à l'octet ; 8 tests `[ORACLE-*]` |
| AUD-02 | 48 cas d'offres et 38 points de classement inchangés ; TypeScript et SQL d'accord avec l'oracle |
| AUD-03 | harnais `[15a]`–`[15g]`, `[AUD03-SQL]` |
| AUD-04 | harnais `[16a]`–`[16i]`, `[MODEL-8]`, `[MODEL-10]`, `[AUD04-1..2]` |
| AUD-05 | harnais `[18]` : contrôle positif + cinq sosies, `[AUD05-SQL]` |
| AUD-06 | quatre combinaisons `LOGIN × BYPASSRLS` et rôle initialement absent restaurés exactement, **après** les deux corrections ; M3 toujours discriminant |
| Lord Howe | ambiguë, inexistante et ordinaire, dans les deux sens |
| occurrence tout-ou-rien | `[AUD02-SQL-3]` |
| nonce manquant / changé | `[G]` « marqueur retiré » et « marqueur changé », zéro mutation ; M4 |
| garde `data_directory` | `[G]`, zéro mutation ; M5 |
| garde `config_file` | `[G]`, zéro mutation ; M5 |
| rejet de `PGHOSTADDR` | code 2, valeur jamais journalisée, nocivité toujours démontrée en `[F]` |
| isolation multi-locataires | harnais `[3]`, tests de tenant obsolète |
| réutilisation de l'autorité de tarification | harnais `[10]`, `[13e]`, `[NO-SECOND-ENGINE-1..2]` |
| retour arrière | harnais `[13a]`–`[13g]` |
| frontière de propriété Debussy | `[OWNERSHIP-1..3]` |
| identités de régression | jeux octet-identiques à la base |

**Réserve d'intégration, à ne pas appliquer maintenant.** Au moment de la
recomposition, `[OWNERSHIP-2]` (« exactement 14 clés MCC ») doit devenir
un invariant de **propriété** : « CSDJ-1 n'ajoute ni ne modifie aucune
clé MCC ». THEME & CONTENT SETTINGS v1 (Debussy, PR #134) a légitimement
porté le catalogue à 17. Sur `412dbb5`, où ce candidat est construit, 14
est la valeur juste — le changer maintenant modifierait un contrat clos
sans nécessité pour exécuter ce candidat.

Aucune fonction préexistante n'est redéfinie : `create_order` et
`resolve_delivery_fulfillment` sont intactes, et le post-vol comme le
harnais le constatent. Aucune fonction préexistante n'est
redéfinie : `create_order` et `resolve_delivery_fulfillment` sont
intactes, et le post-vol comme le harnais le constatent.

Préservés également : aucune fuite de fournisseur, aucun second moteur
de prix, aucun texte Theme/MCC, aucune interface de paiement, aucun
instantané de commande, aucune API transporteur, aucune application
hébergée, aucun merge, aucun déploiement.

---

## §7 — Limites

SQL **DRAFT** uniquement. Aucun merge, aucun déploiement, aucun PREPROD,
aucune mutation Production, aucune modification de `main`. Le candidat
n'est pas poussé : le proxy git de la session refuse l'écriture sur ce
dépôt.
