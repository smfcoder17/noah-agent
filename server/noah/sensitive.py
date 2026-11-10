"""Masquage d'affichage des notifications, réglé par compte."""
import re


def luhn(value: str) -> bool:
    digits = re.sub(r"\D", "", value)
    if not 13 <= len(digits) <= 19 or len(set(digits)) < 2:
        return False
    total = 0
    for i, char in enumerate(reversed(digits)):
        n = int(char) * (2 if i % 2 else 1)
        total += n - 9 if n > 9 else n
    return total % 10 == 0


def mask(value: str) -> str:
    value = re.sub(r"[\w.!#$%&'*+/=?^`{|}~-]+@([\w-]+\.)+[\w-]+", lambda m: m[0].split("@")[0][:2] + "•••@" + m[0].split("@")[1][:1] + "•••." + m[0].split(".")[-1], value)
    cards = re.compile(r"(?<!\d)(?=((?:(?:\d{4}[ -]){2}\d{4}[ -]\d{1,4}(?:[ -]\d{1,3})?|\d{4}[ -]\d{6}[ -]\d{5}|\d{13,19}))(?!\d))")
    spans, end = [], 0
    for m in cards.finditer(value):
        if m.start() >= end and luhn(m[1]):
            end = m.start() + len(m[1])
            spans.append((m.start(), end, "•••• •••• •••• " + re.sub(r"\D", "", m[1])[-4:]))
    for start, end, replacement in reversed(spans):
        value = value[:start] + replacement + value[end:]
    def phone(m):
        n = re.sub(r"\D", "", m[0])
        return ("+" if m[0].startswith("+") else "") + n[:2] + " ••• •• " + n[-2:] if 10 <= len(n) <= 15 else m[0]
    return re.sub(r"(?<![\w\d])(?:\+\d{1,3}[ .()-]*|0)(?:\d[ .()-]*){8,13}\d(?!\d)|(?<![\w\d])\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}(?!\d)", phone, value)
