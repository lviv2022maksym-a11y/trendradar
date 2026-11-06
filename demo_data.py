"""Штучні годинні свічки для перевірки коду без інтернету (НЕ справжній ринок)."""
import functools
import zlib

import numpy as np
import pandas as pd

START = {"BTC-USD": 60000, "ETH-USD": 3000, "SOL-USD": 150, "GC=F": 2400, "^GSPC": 5500, "^NDX": 19000}
VOL = {"BTC-USD": 0.006, "ETH-USD": 0.008, "SOL-USD": 0.010, "GC=F": 0.0025, "^GSPC": 0.003, "^NDX": 0.0035}


@functools.lru_cache(maxsize=32)
def synthetic_hourly(symbol: str, n: int = 24 * 400, seed: int | None = None) -> pd.DataFrame:
    rng = np.random.default_rng(seed if seed is not None else zlib.crc32(symbol.encode()))
    vol = VOL.get(symbol, 0.006)
    drift = np.repeat(rng.normal(0, vol / 10, n // 600 + 1), 600)[:n]   # режими тренду
    rets = drift + rng.standard_t(4, n) * vol / np.sqrt(2)
    close = START.get(symbol, 100) * np.exp(np.cumsum(rets))
    open_ = np.r_[close[0], close[:-1]]
    wick = np.abs(rng.normal(0, vol / 2, n)) * close
    high, low = np.maximum(open_, close) + wick, np.minimum(open_, close) - wick
    volume = rng.lognormal(10, 0.4, n) * (1 + 30 * np.abs(rets))
    end = pd.Timestamp.now(tz="UTC").floor("1h") - pd.Timedelta(hours=1)
    idx = pd.date_range(end=end, periods=n, freq="1h").as_unit("ns")
    return pd.DataFrame({"open": open_, "high": high, "low": low, "close": close, "volume": volume}, index=idx)
