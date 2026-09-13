### Hi, I'm Patryk

Software engineer from Poland. I design and ship distributed, multi-tenant systems end to end,
mostly with Java and Spring Boot on the backend and Angular on the frontend.

Lately I've been focused on identity and access management and on tooling around LLMs.

Contact: [contact@pjugowiec.com](mailto:contact@pjugowiec.com)

<!-- STATS:START -->
<!-- stats:total=1373 -->
**1,373** contributions in the last 12 months

| Metric | Value |
| :--- | ---: |
| Active days | 140 / 365 |
| In private repositories | 99% |
| Commits | 1,200 |
| Pull requests | 102 |
| Code reviews | 8 |

![Top languages: Java 41.8%, TypeScript 23.4%, Pascal 22.7%, Python 5.7%, JavaScript 4.7%, Other 1.7%](assets/langs.svg)

Last updated: 2026-09-13T17:35:03Z · includes private contributions
<!-- STATS:END -->

<!--
NOTATKI DLA WŁAŚCICIELA (niewidoczne na profilu)

Statystyki powyżej generuje scripts/stats.mjs, uruchamiany przez .github/workflows/stats.yml
codziennie o 04:00 UTC. Wszystko między znacznikami STATS jest nadpisywane, nie edytuj ręcznie.

1. Token
   Skrypt musi działać jako Ty (viewer = pjugowiec) i widzieć prywatne kontrybucje.
   Uwaga: token OAuth z `gh auth token` NIE widzi prywatnych kontrybucji (zwraca ~9 zamiast ~1,3 tys.),
   więc przed dodaniem sekretu sprawdź wybrany token lokalnie (krok 3).

   Wariant A, classic PAT (sprawdzony wzorzec dla prywatnych kontrybucji):
     github.com/settings/tokens > Generate new token (classic)
     Scopes: repo, read:user
     Expiration: np. 1 rok, wpisz sobie przypomnienie o rotacji.
     Minus: scope `repo` daje też zapis, token trzymaj wyłącznie w sekrecie Actions.

   Wariant B, fine-grained PAT (tylko odczyt, spróbuj najpierw):
     github.com/settings/personal-access-tokens/new
     Resource owner: pjugowiec, Repository access: All repositories
     Repository permissions: Metadata: Read-only, Contents: Read-only
     Jeśli dry-run pokaże "In private repositories 0%" albo zaniżoną sumę, przejdź na wariant A.

2. Sekret
   Repo pjugowiec/pjugowiec > Settings > Secrets and variables > Actions > New repository secret
     Name: GH_STATS_TOKEN
     Value: token z kroku 1
   Albo z terminala: gh secret set GH_STATS_TOKEN
   Stary sekret GH_PAT (po usuniętym workflow badge'a) można skasować. Widział on prywatne
   kontrybucje, więc jeśli masz jeszcze ten token, możesz go użyć jako GH_STATS_TOKEN.

3. Weryfikacja lokalna (nic nie zapisuje)
   GH_STATS_TOKEN=<token> node scripts/stats.mjs --dry-run
   Suma powinna zgadzać się z kalendarzem na profilu, a udział prywatnych repo być > 0%.
   Testy: node --test scripts/stats.test.mjs

4. Pierwsze uruchomienie
   Actions > Refresh stats > Run workflow.
   Jeśli suma kontrybucji spadnie o ponad 50% względem poprzedniej, run kończy się błędem
   i nic nie zapisuje (zwykle oznacza to token bez dostępu do prywatnych kontrybucji).
   Świadomy reset: Run workflow z zaznaczonym "force" albo lokalnie z flagą --force.

5. Konfiguracja
   Wiersze, próg (PR >= 25) i lista ignorowanych języków: stała DISPLAY
   na górze scripts/stats.mjs.
-->
