# Mise en forme des agents : mesure du 2026-11-19

Le prompt complet d'un agent (`server/noah/main.py`, `_soul`) et 50 demandes variées (dont 5 qui demandent du code), envoyés à trois modèles d'Ollama Cloud. Le code (`tools/eval/format-agents.mjs`) compte les réponses qui contiennent un élément interdit : tableau Markdown, bloc de code hors demande de code, JSON dans le texte, flèche, symbole décoratif, adresse nue, liste de plus de six puces. Critère : moins de 2 réponses sur 50 par modèle.

| Prompt | Modèle | Réponses | Avec un élément interdit | Détail |
|---|---|---|---|---|
| avec la consigne | deepseek-v4.1-flash | 50/50 | 0 | aucun |
| avec la consigne | gpt-oss:20b | 49/50 | 6 | json 3, adresse nue 1, liste longue 1, tableau 2 |
| avec la consigne | glm-5.3-flash | 49/50 | 4 | json 3, symbole décoratif 1 |

Critère (moins de 2 sur 50 avec la consigne, par modèle) : NON atteint.

Jetons : 1480127 en entrée, 109384 en sortie. Coût estimé : 0.58 $ (estimation à 0,30 $ et 1,20 $ le million de jetons ; l'abonnement Ollama Cloud ne facture pas au jeton).
