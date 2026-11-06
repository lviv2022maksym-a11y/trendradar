"""Одноразове налаштування Telegram-бота: назва та опис трьома мовами.
Аватарку Telegram дозволяє змінити лише через @BotFather → /setuserpic (файл assets/avatar.png).

  TELEGRAM_TOKEN=... python setup_bot.py
"""
import settings
import telegram
from i18n import set_language, t

NAME = "TrendRadar"
INFO = {
    "uk": ("📡 TrendRadar стежить за криптовалютами, золотом і акціями США 24/7 і пише, коли умови ВИГІДНІ для покупки, "
           "а коли краще почекати. Пояснює чому, рахує розмір покупки, стоп-лос і ціль, веде віртуальний портфель. "
           "Сигнали за правилами — не гарантія прибутку.",
           "Сигнали BTC, ETH, золото, S&P 500: вигідно чи ні, чому і скільки купляти."),
    "en": ("📡 TrendRadar watches crypto, gold and US stocks 24/7 and tells you when conditions are FAVORABLE to buy "
           "and when it is better to wait. Explains why, sizes the position, sets stop-loss and target, runs a paper portfolio. "
           "Rule-based signals — not a profit guarantee.",
           "Signals for BTC, ETH, gold, S&P 500: favorable or not, why and how much."),
    "ru": ("📡 TrendRadar следит за криптовалютами, золотом и акциями США 24/7 и пишет, когда условия ВЫГОДНЫ для покупки, "
           "а когда лучше подождать. Объясняет почему, считает размер покупки, стоп-лосс и цель, ведёт виртуальный портфель. "
           "Сигналы по правилам — не гарантия прибыли.",
           "Сигналы BTC, ETH, золото, S&P 500: выгодно или нет, почему и сколько покупать."),
}


def main() -> None:
    cfg = settings.load()
    default = cfg["language"] if cfg["language"] in INFO else "uk"
    ok = telegram.bot_api("setMyName", name=NAME)
    for code in [None, *INFO]:        # None — опис за замовчуванням
        desc, short = INFO[code or default]
        ok &= telegram.bot_api("setMyDescription", description=desc, language_code=code)
        ok &= telegram.bot_api("setMyShortDescription", short_description=short, language_code=code)
    set_language(default)
    msg = t("setup_done")
    print(msg)
    if ok:
        telegram.send(msg)


if __name__ == "__main__":
    main()
