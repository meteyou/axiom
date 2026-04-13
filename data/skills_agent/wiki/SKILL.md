---
name: wiki
description: Pflege und durchsuche das persönliche LLM-Wiki (Wissensbase aus Markdown-Seiten). Verwende diesen Skill für Ingest neuer Quellen, Queries gegen das Wiki, und Wiki-Pflege/Linting.
---

# Wiki Skill

Das Wiki liegt unter `/data/memory/wiki/`. Es ist eine Sammlung von LLM-gepflegten Markdown-Dateien – eine persönliche Wissensbasis nach dem Karpathy-Konzept.

## Wiki-Struktur

Jede Wiki-Seite ist eine `.md`-Datei unter `/data/memory/wiki/`. Seiten können optionalen YAML-Frontmatter mit Aliases enthalten:

```markdown
---
aliases: [kurzname, abkürzung]
---

# Seitentitel

Inhalt der Seite...
```

## Operationen

### Ingest — Neue Quellen einpflegen

Ziel: Wissen aus einer externen Quelle (URL, Datei, Chat-Kontext) in das Wiki aufnehmen.

**Vorgehen:**

1. Lies zunächst alle bestehenden Wiki-Seiten via `list_files /data/memory/wiki/`:
   - Welche Seiten existieren bereits?
   - Gibt es eine passende Seite, die erweitert werden sollte?

2. Extrahiere das wesentliche Wissen aus der Quelle:
   - Fakten, Konzepte, Entscheidungen, Abhängigkeiten
   - Keine Duplikation von bereits vorhandenem Wissen
   - Fokus auf Evergreen-Wissen (dauerhaft nützlich, nicht ephemer)

3. Entscheide: Neue Seite erstellen oder bestehende ergänzen?
   - Neue Seite: wenn es ein neues Thema/Projekt/Konzept ist
   - Bestehende Seite: wenn das Wissen zu einer vorhandenen Seite gehört

4. Schreibe die Seite:
   - Dateiname: `thema-name.md` (Kleinbuchstaben, Bindestriche statt Leerzeichen)
   - Erster Heading `# Titel` (klar und präzise)
   - Struktur: Überschriften, Aufzählungen, Codeblöcke wo sinnvoll
   - Cross-Links: Verweise auf verwandte Wiki-Seiten (`[Seitenname](seitenname.md)`)

**Beispiel — Web-Artikel einpflegen:**
```
1. web_fetch die URL
2. list_files /data/memory/wiki/
3. Relevantes extrahieren, Duplikate erkennen
4. write_file /data/memory/wiki/thema.md mit dem destillierten Wissen
```

**Beispiel — Kontext aus Gespräch einpflegen:**
```
1. list_files /data/memory/wiki/
2. Prüfen ob passende Seite existiert
3. Falls ja: edit_file um Abschnitt hinzuzufügen
4. Falls nein: write_file neue Seite anlegen
```

---

### Query — Wiki abfragen

Ziel: Das Wiki nach relevantem Wissen für eine aktuelle Aufgabe durchsuchen.

**Vorgehen:**

1. `list_files /data/memory/wiki/` — alle Seiten auflisten
2. Dateinamen scannen: Welche Seiten könnten relevant sein?
3. Relevante Seiten mit `read_file` lesen
4. Falls eine Seite auf andere verlinkt (`[Name](datei.md)`): auch diese lesen

**Tipps:**
- Bei breiten Themen: mehrere Seiten lesen, dann synthetisieren
- Bei spezifischen Fragen: gezielt eine/zwei Seiten lesen
- Wenn keine passende Seite existiert: das dem Nutzer mitteilen und ggf. eine neue Seite anlegen

**Wann das Wiki nutzen:**
- Vor technischen Fragen zu bekannten Projekten/Systemen
- Bei wiederkehrenden Themen (Tools, Workflows, Konfigurationen)
- Wenn der Nutzer fragt "wie machen wir X normalerweise?"

---

### Lint — Wiki-Pflege und Health-Check

Ziel: Das Wiki auf Qualität prüfen – Widersprüche, verwaiste Seiten, fehlende Links finden.

**Vorgehen:**

1. **Alle Seiten lesen:**
   ```
   list_files /data/memory/wiki/
   read_file jede Seite
   ```

2. **Widersprüche suchen:**
   - Gleiche Fakten unterschiedlich beschrieben?
   - Veraltete Informationen die korrigiert werden sollten?
   - Duplikate (gleiches Wissen auf mehreren Seiten)?

3. **Verwaiste Seiten identifizieren:**
   - Welche Seiten werden von keiner anderen Seite verlinkt?
   - Sind diese Seiten trotzdem wertvoll (standalone-Dokumente)?

4. **Fehlende Cross-Links erkennen:**
   - Konzepte die auf Seite A erwähnt werden, für die es Seite B gibt – aber kein Link?
   - Cross-Links hinzufügen mit `edit_file`

5. **Lint-Report schreiben:**
   - Befunde in die heutige Daily-Datei schreiben:
     ```
     read_file /data/memory/daily/YYYY-MM-DD.md (oder ensureDailyFile)
     edit_file: ## Wiki Lint Report — YYYY-MM-DD\n\n### Befunde\n- ...
     ```

6. **Fixes anwenden:**
   - Offensichtliche Korrekturen direkt vornehmen (edit_file)
   - Nur wenn sicher – keine spekulativen Änderungen

**Lint-Report Format:**
```markdown
## Wiki Lint Report — 2025-01-15

### Widersprüche
- `projekt-x.md` und `architektur.md` beschreiben die Datenbankstruktur unterschiedlich

### Verwaiste Seiten
- `alter-service.md` — wird nirgends verlinkt, evtl. löschen?

### Fehlende Cross-Links
- `deployment.md` erwähnt Docker aber kein Link zu `docker.md`

### Veraltete Informationen
- `setup.md` referenziert noch Node 16, aktuell ist Node 20
```

---

## Dateinamen-Konventionen

- Kleinbuchstaben: `mein-projekt.md` nicht `MeinProjekt.md`
- Bindestriche statt Leerzeichen: `api-design.md`
- Beschreibend und eindeutig: `openagent-deployment.md` statt `deployment.md` wenn mehrere Projekte
- Keine Sonderzeichen außer `-` und `_`

## Qualitätsprinzipien (nach Karpathy)

1. **Jedes Wissen lebt an genau einem Ort** — kein Copy-Paste zwischen Seiten, stattdessen Cross-Links
2. **Kurz und präzise** — Wiki-Seiten sind Referenz, kein Prosa-Text
3. **Immer aktuell** — veraltete Infos korrigieren, nicht nur neue hinzufügen
4. **Verlinkt** — Wiki-Seiten sollten aufeinander verweisen, um ein Netz zu bilden
5. **Evergreen** — ephemere Infos gehören in daily-Dateien, nicht ins Wiki

## Pfade

- Wiki-Verzeichnis: `/data/memory/wiki/`
- Heutiges Daily (für Lint-Reports): `/data/memory/daily/YYYY-MM-DD.md`
- Alle Pfade sind absolut anzugeben
