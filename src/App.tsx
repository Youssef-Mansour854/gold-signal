import { useEffect, useState } from "react";

type PricePoint = {
  price: number;
  sourceUpdatedAt: string;
  observedAt: string;
};

type TechnicalSignal = {
  direction: "buy" | "sell" | "wait";
  shortAverage: number;
  longAverage: number;
  changePercent: number;
};

type Recommendation = {
  id: number;
  status: "open" | "success" | "failed";
  direction: "buy" | "sell";
  entryPrice: number;
  takeProfit: number;
  stopLoss: number;
  initialStopLoss: number | null;
  takeProfit1: number | null;
  takeProfit2: number | null;
  takeProfit3: number | null;
  nextTarget: number;
  remainingFraction: number;
  realizedPercent: number;
  managementVersion: string;
  stopPercent: number;
  shortAverage: number;
  longAverage: number;
  changePercent: number;
  strategyVersion: string;
  priceSource: string;
  providerUpdatedAt: string;
  createdAt: string;
  closedAt: string | null;
  exitPrice: number | null;
  resultPercent: number | null;
  closeReason: "take_profit" | "take_profit_3" | "stop_loss" | "time_limit" | null;
  costEstimateModel: string | null;
  estimatedSpreadUsdPerOunce: number | null;
  estimatedSlippageUsdPerOunce: number | null;
  estimatedCommissionUsdPerOunce: number | null;
  estimatedTotalCostUsdPerOunce: number | null;
  estimatedNetResultPercent: number | null;
  estimatedNetIfClosedNow: number | null;
  observationCount: number;
  openObservationCount: number;
  postCloseObservationCount: number;
  durationMinutes: number;
  openObservedLow: number | null;
  openObservedHigh: number | null;
  postCloseObservedLow: number | null;
  postCloseObservedHigh: number | null;
  lastObservationAt: string | null;
  dataGapCount: number;
  accountEquityAtEntry: number | null;
  riskBudgetUsd: number | null;
  virtualQuantityOunces: number | null;
  realizedGrossUsd: number;
  estimatedCostUsd: number;
  realizedNetUsd: number;
  accountEquityAfter: number | null;
  accountModel: string | null;
  events: RecommendationEvent[];
};

type RecommendationEvent = {
  id: number;
  eventType: "target_hit" | "stop_moved" | "stopped_out" | "trade_closed";
  targetNumber: number | null;
  price: number;
  quantityFraction: number;
  contributionPercent: number;
  currentStopLoss: number;
  occurredAt: string;
  estimatedCostUsdPerOunce: number | null;
  netContributionPercent: number | null;
  pointMove: number | null;
  grossPnlUsd: number | null;
  estimatedCostUsd: number | null;
  netPnlUsd: number | null;
  accountEquityAfter: number | null;
};

type EconomicEvent = {
  id: string;
  releaseId: number;
  name: string;
  date: string;
  impact: "high";
  source: "FRED";
};

type StrategyComparisonTrade = {
  id: number;
  status: "open" | "success" | "failed";
  direction: "buy" | "sell";
  entryPrice: number;
  exitPrice: number | null;
  grossUsd: number | null;
  estimatedCostUsd: number | null;
  netUsd: number | null;
  closeReason: string | null;
  quantityOunces: number;
  lotSize: number;
  openedAt: string;
  closedAt: string | null;
};

type StrategyComparisonAccount = {
  id: number;
  strategyId: string;
  strategyName: string;
  sizingModeName: string;
  equityUsd: number;
  startingEquityUsd: number;
  realizedGrossUsd: number;
  estimatedCostUsd: number;
  realizedNetUsd: number;
  tradeCount: number;
  winCount: number;
  lossCount: number;
  openTradeCount: number;
  trades: StrategyComparisonTrade[];
};

type NewsGuard = {
  provider: "FRED";
  status: "ready" | "not_configured" | "loading" | "error" | "stale";
  blocked: boolean;
  today: string;
  timezone: string;
  todayEvents: EconomicEvent[];
  upcomingEvents: EconomicEvent[];
  checkedAt: string | null;
  message: string;
  details: string;
  timePrecision: "date-only";
};

type DashboardState = {
  latest: (PricePoint & { currency: string; symbol: string }) | null;
  points: PricePoint[];
  signal: TechnicalSignal | null;
  activeRecommendation: Recommendation | null;
  recommendations: Recommendation[];
  virtualAccount: {
    startingEquityUsd: number;
    sizingRule: string;
    lotStepUsd: number;
    lotStepSize: number;
    ouncesPerLot: number;
    realizedNetUsd: number;
    equityUsd: number;
    returnPercent: number;
  };
  strategyComparison: {
    startingEquityUsd: number;
    accounts: StrategyComparisonAccount[];
  };
  priceFreshness: {
    status: "fresh" | "stale" | "unavailable";
    ageSeconds: number | null;
    staleAfterSeconds: number;
  };
  costEstimate: {
    model: string;
    label: string;
    spreadUsdPerOunce: number;
    slippageUsdPerOunce: number;
    commissionUsdPerOunce: number;
    totalUsdPerOunce: number;
  };
  newsGuard: NewsGuard;
  sourceError: string;
  strategy: {
    version: string;
    tradeManagementVersion: string;
    requiredSamples: number;
    targetRMultipliers: number[];
    stopPercent: number;
  };
};

function formatPrice(value: number) {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatPercent(value: number) {
  const normalized = value === 0 ? 0 : value;
  return `${normalized > 0 ? "+" : ""}${normalized.toFixed(3)}%`;
}

function formatDollar(value: number) {
  // -0 would otherwise render as "+$0.00".
  const normalized = value === 0 ? 0 : value;
  return `${normalized >= 0 ? "+" : "-"}$${Math.abs(normalized).toFixed(2)}`;
}

function formatCost(value: number) {
  return `$${value.toFixed(3)}/أونصة`;
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("ar-EG", {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(value));
}

const directionLabels = { buy: "شراء", sell: "بيع", wait: "انتظار" } as const;
const statusLabels = { open: "مفتوحة", success: "نجحت", failed: "فشلت" } as const;

function App() {
  const [dashboard, setDashboard] = useState<DashboardState | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const [selectedStrategyId, setSelectedStrategyId] = useState("all");

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 2_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();

    async function updateDashboard() {
      try {
        const response = await fetch("/api/state", { signal: controller.signal });
        if (!response.ok) {
          throw new Error(`تعذر جلب بيانات اللوحة (HTTP ${response.status})`);
        }
        const data = (await response.json()) as DashboardState;
        if (!active) return;
        setDashboard(data);
        setError(data.sourceError);
      } catch (requestError) {
        if (!active || (requestError instanceof Error && requestError.name === "AbortError")) {
          return;
        }
        setError(
          requestError instanceof Error
            ? requestError.message
            : "حدث خطأ غير متوقع أثناء تحميل البيانات.",
        );
      } finally {
        if (active) {
          setLoading(false);
          timer = setTimeout(updateDashboard, 10_000);
        }
      }
    }

    void updateDashboard();
    return () => {
      active = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, []);

  const latest = dashboard?.latest ?? null;
  const points = dashboard?.points ?? [];
  const signal = dashboard?.signal ?? null;
  const change = points.length > 1
    ? points[points.length - 1].price - points[points.length - 2].price
    : 0;
  const hasPositiveChange = change > 0;
  const hasNegativeChange = change < 0;
  const signalTone = signal?.direction ?? "loading";
  const signalLabel = signal ? directionLabels[signal.direction] : "جارٍ التحليل";
  const recommendations = dashboard?.recommendations ?? [];
  // The server age is a snapshot: keep counting locally when polling fails.
  const quoteUnavailable = !dashboard || dashboard.priceFreshness.status === "unavailable" || !latest;
  const reportedAge = dashboard?.priceFreshness.ageSeconds ?? null;
  const liveAge = latest
    ? Math.max(0, Math.floor((now - Date.parse(latest.observedAt)) / 1000))
    : null;
  const quoteAgeSeconds = reportedAge === null || liveAge === null
    ? null
    : Math.max(reportedAge, liveAge);
  const quoteStaleAfterSeconds = dashboard?.priceFreshness.staleAfterSeconds ?? 120;
  const isQuoteStale = quoteUnavailable || !!error
    || quoteAgeSeconds === null || quoteAgeSeconds >= quoteStaleAfterSeconds;
  const activeTrade = dashboard?.activeRecommendation ?? null;
  const activeTradeDurationMinutes = activeTrade
    ? Math.max(
      activeTrade.durationMinutes,
      Math.floor((now - Date.parse(activeTrade.createdAt)) / 60_000),
    )
    : null;
  const comparisonAccounts = dashboard?.strategyComparison.accounts ?? [];
  const strategyOptions = comparisonAccounts.reduce<{ id: string; name: string }[]>(
    (options, account) => {
      if (!options.some((option) => option.id === account.strategyId)) {
        options.push({ id: account.strategyId, name: account.strategyName });
      }
      return options;
    },
    [],
  );
  const visibleComparisonAccounts = selectedStrategyId === "all"
    ? comparisonAccounts
    : comparisonAccounts.filter((account) => account.strategyId === selectedStrategyId);

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="نبض الذهب - الرئيسية">
          <span className="brand-mark" aria-hidden="true">Au</span>
          <span>نبض <strong>الذهب</strong></span>
        </a>
        <div className="market-status">
          <span className={`status-dot ${error || isQuoteStale ? "status-error" : ""}`} />
          {error ? "مصدر السعر غير متاح" : isQuoteStale ? "السعر قديم" : "مصدر السعر متصل"}
        </div>
      </header>

      <section className="intro">
        <div>
          <p className="eyebrow">لوحة متابعة السوق</p>
          <h1>الذهب <span>الفوري</span></h1>
          <p className="intro-copy">
            تابع السعر وإشارات الاتجاه الفنية للذهب مقابل الدولار.
          </p>
        </div>
        <div className="symbol-badge"><span>XAU</span><i>/</i> USD</div>
      </section>

      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <span>سيحاول التطبيق الاتصال مرة أخرى تلقائيًا.</span>
        </div>
      )}
      {dashboard && isQuoteStale && (
        <div className="error-banner" role="status">
          {error
            ? "الخادم أو مصدر السعر غير متاح؛ تُعرض أحدث بيانات معروفة وقد تكون قديمة."
            : quoteUnavailable
              ? "لا توجد قراءة سعر متاحة بعد."
              : `لا توجد قراءة سعر جديدة منذ ${quoteAgeSeconds ?? 0} ثانية؛ أوقف النظام تقييم TP/SL حتى وصول سعر حديث.`}
        </div>
      )}

      <section className="dashboard-grid" aria-label="بيانات الذهب">
        <article className="panel price-panel">
          <div className="panel-heading">
            <div>
              <p className="panel-label">سعر الأونصة</p>
              <h2>السعر الحالي <span className="live-tag">كل 30 ثانية</span></h2>
            </div>
            <span className="gold-icon" aria-hidden="true">Au</span>
          </div>
          <div className="price-value">
            {loading && !latest ? <span className="skeleton">جاري التحميل</span> : (
              <>
                <span className="currency">$</span>
                <span>{latest ? formatPrice(latest.price) : "—"}</span>
              </>
            )}
          </div>
          <div className={`price-change ${hasPositiveChange ? "positive" : hasNegativeChange ? "negative" : ""}`}>
            <span aria-hidden="true">{hasPositiveChange ? "↑" : hasNegativeChange ? "↓" : "↔"}</span>
            <span>{change === 0 ? "بانتظار القراءة التالية" : formatDollar(change)}</span>
            <span className="change-caption">من آخر قراءة محفوظة</span>
          </div>
          <div className="price-divider" />
          <div className="data-row">
            <span>وقت رصد السعر</span>
            <strong>{latest?.observedAt ? formatDateTime(latest.observedAt) : "—"}</strong>
          </div>
          <div className="data-row">
            <span>مصدر السعر</span>
            <strong>Gold API · XAU/USD</strong>
          </div>
          <div className="data-row">
            <span>دورية الحفظ</span>
            <strong>كل 30 ثانية</strong>
          </div>
          <div className="data-row">
            <span>عمر آخر قراءة</span>
            <strong>
              {quoteAgeSeconds === null ? "غير متاح" : `${quoteAgeSeconds} ثانية`}
            </strong>
          </div>
        </article>

        <article className={`panel signal-panel signal-${signalTone}`}>
          <div className="panel-heading">
            <div>
              <p className="panel-label">قراءة فنية آلية</p>
              <h2>إشارة الاتجاه</h2>
            </div>
            <span className={`signal-icon signal-icon-${signalTone}`} aria-hidden="true">
              {signal?.direction === "buy" ? "↗" : signal?.direction === "sell" ? "↘" : "↔"}
            </span>
          </div>
          <div className="signal-result">
            <span className={`signal-pill pill-${signalTone}`}>
              <span className="signal-pulse" />
              {signalLabel}
            </span>
            <p>
              {signal
                ? signal.direction === "wait"
                  ? "الاتجاه غير متوافق بوضوح؛ لا توجد إشارة جديدة."
                  : `الاتجاه ${signal.direction === "buy" ? "صاعد" : "هابط"} حسب متوسطات السعر الأخيرة.`
                : `نجمع قراءات السعر (${points.length}/${dashboard?.strategy.requiredSamples ?? 12}) قبل إظهار الإشارة.`}
            </p>
          </div>
          <div className="signal-metrics">
            <div>
              <span>المتوسط القصير · 5 قراءات</span>
              <strong>{signal ? `$${formatPrice(signal.shortAverage)}` : "—"}</strong>
            </div>
            <div>
              <span>المتوسط العام · 12 قراءة</span>
              <strong>{signal ? `$${formatPrice(signal.longAverage)}` : "—"}</strong>
            </div>
            <div>
              <span>التغير خلال القراءات</span>
              <strong className={signal && signal.changePercent < 0 ? "negative-text" : "positive-text"}>
                {signal ? formatPercent(signal.changePercent) : "—"}
              </strong>
            </div>
          </div>
          <p className="method-note">
            وقف ابتدائي {dashboard?.strategy.stopPercent ?? 0.5}% · الأهداف{" "}
            {(dashboard?.strategy.targetRMultipliers ?? [1, 2, 3]).join("R / ")}R
            · الإشارة لا ترسل أوامر تداول.
          </p>
        </article>
      </section>

      {dashboard?.newsGuard && <NewsPanel newsGuard={dashboard.newsGuard} />}

      {dashboard?.virtualAccount && (
        <section className="panel virtual-account">
          <div className="activity-heading">
            <div>
              <p className="panel-label">حساب محاكاة افتراضي · غير حقيقي</p>
              <h2>الحساب ${formatPrice(dashboard.virtualAccount.startingEquityUsd)}</h2>
            </div>
            <span className={`status-tag ${dashboard.virtualAccount.returnPercent >= 0 ? "success" : "failed"}`}>
              العائد {formatPercent(dashboard.virtualAccount.returnPercent)}
            </span>
          </div>
          <div className="virtual-account-grid">
            <div><span>الرصيد الابتدائي</span><strong>${formatPrice(dashboard.virtualAccount.startingEquityUsd)}</strong></div>
            <div><span>الرصيد المحاكاة الحالي</span><strong>${formatPrice(dashboard.virtualAccount.equityUsd)}</strong></div>
            <div><span>صافي الربح/الخسارة المحقق</span><strong>{formatDollar(dashboard.virtualAccount.realizedNetUsd)}</strong></div>
            <div><span>قاعدة الحجم</span><strong>{dashboard.virtualAccount.sizingRule}</strong></div>
          </div>
        </section>
      )}

      {dashboard?.strategyComparison && (
        <section className="panel strategy-comparison">
          <div className="activity-heading">
            <div>
              <p className="panel-label">مقارنة منفصلة · محاكاة فقط</p>
              <h2>الاستراتيجية الأساسية + 4 استراتيجيات × 3 سيناريوهات حجم</h2>
            </div>
            <span className="history-count">
              بداية كل حساب ${formatPrice(dashboard.strategyComparison.startingEquityUsd)}
            </span>
          </div>
          <div className="strategy-tabs" role="group" aria-label="اختيار الاستراتيجية المعروضة">
            <button
              type="button"
              className={`strategy-tab ${selectedStrategyId === "all" ? "active" : ""}`}
              aria-pressed={selectedStrategyId === "all"}
              onClick={() => setSelectedStrategyId("all")}
            >
              الكل
            </button>
            {strategyOptions.map((option) => (
              <button
                key={option.id}
                type="button"
                className={`strategy-tab ${selectedStrategyId === option.id ? "active" : ""}`}
                aria-pressed={selectedStrategyId === option.id}
                onClick={() => setSelectedStrategyId(option.id)}
              >
                {option.name}
              </button>
            ))}
          </div>
          <div className="strategy-account-grid">
            {visibleComparisonAccounts.map((account) => {
              const returnPercent = ((account.equityUsd - account.startingEquityUsd) /
                account.startingEquityUsd) * 100;
              return (
                <article className="strategy-account-card" key={account.id}>
                  <div className="strategy-account-title">
                    <strong>{account.strategyName}</strong>
                    <span>{account.sizingModeName}</span>
                  </div>
                  <div className="strategy-account-metrics">
                    <div><span>الرصيد الحالي</span><strong>${formatPrice(account.equityUsd)}</strong></div>
                    <div><span>صافي المحقق</span><strong>{formatDollar(account.realizedNetUsd)}</strong></div>
                    <div><span>العائد</span><strong>{formatPercent(returnPercent)}</strong></div>
                    <div><span>الصفقات / الناجحة / الخاسرة</span><strong>{account.tradeCount} / {account.winCount} / {account.lossCount}</strong></div>
                  </div>
                  {account.trades.slice(0, 3).map((trade) => (
                    <div className="strategy-account-trade" key={trade.id}>
                      <span>
                        #{trade.id} · {trade.direction === "buy" ? "شراء" : "بيع"}
                        {" · "}دخول ${formatPrice(trade.entryPrice)}
                        {trade.exitPrice !== null && ` · خروج $${formatPrice(trade.exitPrice)}`}
                      </span>
                      {trade.netUsd !== null && (
                        <strong>{formatDollar(trade.netUsd)}</strong>
                      )}
                      {trade.status === "open" && <strong>مفتوحة · {trade.lotSize.toFixed(2)} lot</strong>}
                    </div>
                  ))}
                  {account.openTradeCount > 0 && <small>يوجد صفقة مفتوحة مستقلة لهذه الاستراتيجية والحجم.</small>}
                </article>
              );
            })}
          </div>
        </section>
      )}

      {dashboard?.activeRecommendation && (
        <section className="panel active-trade">
          <div className="active-trade-heading">
            <span className="signal-pulse" />
            <h2>توصية مفتوحة #{dashboard.activeRecommendation.id}</h2>
            <span className={`direction-tag ${dashboard.activeRecommendation.direction}`}>
              {directionLabels[dashboard.activeRecommendation.direction]}
            </span>
          </div>
          <p>
            دخول: <strong>${formatPrice(dashboard.activeRecommendation.entryPrice)}</strong>
            {dashboard.activeRecommendation.takeProfit1 !== null && (
              <>
                <span> · TP1: </span><strong>${formatPrice(dashboard.activeRecommendation.takeProfit1)}</strong>
                <span> · TP2: </span><strong>${formatPrice(dashboard.activeRecommendation.takeProfit2 ?? dashboard.activeRecommendation.takeProfit)}</strong>
                <span> · TP3: </span><strong>${formatPrice(dashboard.activeRecommendation.takeProfit3 ?? dashboard.activeRecommendation.takeProfit)}</strong>
              </>
            )}
            <span> · الوقف الحالي: </span>
            <strong>${formatPrice(dashboard.activeRecommendation.stopLoss)}</strong>
          </p>
          <small>
            الكمية المتبقية: {(dashboard.activeRecommendation.remainingFraction * 100).toFixed(1)}%
            {" · "}الهدف التالي: {dashboard.activeRecommendation.nextTarget <= 3 ? `TP${dashboard.activeRecommendation.nextTarget}` : "—"}
            {" · "}الوقف: بعد TP1 إلى الدخول وبعد TP2 إلى TP1.
            {" · "}المهلة القصوى: 120 دقيقة.
          </small>
          <small>
            صافي تقديري لو الإغلاق الآن:{" "}
            {dashboard.activeRecommendation.estimatedNetIfClosedNow === null
              ? "غير متاح"
              : formatPercent(dashboard.activeRecommendation.estimatedNetIfClosedNow)}
            {" · "}التكلفة {dashboard.activeRecommendation.estimatedTotalCostUsdPerOunce === null
              ? "غير متاحة"
              : formatCost(dashboard.activeRecommendation.estimatedTotalCostUsdPerOunce)}
            {" · "}حجم افتراضي: {dashboard.activeRecommendation.virtualQuantityOunces === null
              ? "—"
              : `${(dashboard.activeRecommendation.virtualQuantityOunces / dashboard.virtualAccount.ouncesPerLot).toFixed(2)} lot`}
            {" · "}قاعدة: ${dashboard.virtualAccount.lotStepUsd} مقابل {dashboard.virtualAccount.lotStepSize} lot
            {" · "}عمر الصفقة {activeTradeDurationMinutes ?? dashboard.activeRecommendation.durationMinutes} دقيقة
          </small>
        </section>
      )}

      <section className="panel activity-panel">
        <div className="activity-heading">
          <div>
            <p className="panel-label">متابعة لحظية</p>
            <h2>حركة السعر</h2>
          </div>
          <span className="history-count">آخر {points.length} قراءة محفوظة</span>
        </div>
        {points.length > 1 ? (
          <div className="chart-wrap" role="img" aria-label="رسم بياني لقراءات سعر الذهب الأخيرة">
            <Sparkline points={points} />
            <div className="chart-labels"><span>الأقدم</span><span>الأحدث</span></div>
          </div>
        ) : (
          <div className="empty-chart">
            <div className="chart-placeholder" aria-hidden="true">⌁</div>
            <p>
              {error && !dashboard
                ? "تعذر تحميل قراءات السعر؛ سيُعاد المحاولة تلقائيًا."
                : "يظهر الرسم بعد استقبال قراءة أخرى للسعر."}
            </p>
          </div>
        )}
      </section>

      <section className="panel recommendations-panel">
        <div className="activity-heading">
          <div>
            <p className="panel-label">سجل دائم على هذا الجهاز</p>
            <h2>التوصيات ونتائجها</h2>
          </div>
          <span className="history-count">{recommendations.length} توصية</span>
        </div>
        {recommendations.length ? (
          <div className="recommendation-list">
            {recommendations.map((recommendation) => (
              <RecommendationCard
                key={recommendation.id}
                recommendation={recommendation}
                account={dashboard?.virtualAccount ?? null}
              />
            ))}
          </div>
        ) : (
          <div className="empty-recommendations">
            {loading && !error
              ? "جارٍ تحميل السجل..."
              : error && !dashboard
                ? "تعذر تحميل السجل؛ سيُعاد المحاولة تلقائيًا."
                : "لا توجد توصيات مسجلة حتى الآن. سيُحفظ كل دخول جديد تلقائيًا."}
          </div>
        )}
        {recommendations.length === 100 && (
          <p className="history-note">تُعرض آخر 100 توصية؛ السجل الكامل محفوظ في قاعدة البيانات المحلية.</p>
        )}
      </section>

      <aside className="disclaimer">
        <span className="info-icon" aria-hidden="true">i</span>
        <p>
          <strong>للتوعية والتجربة فقط:</strong> الاستراتيجية غير مختبرة: متوسط 5 قراءات مقابل 12 واتجاه التغير.
          تقسيم الصفقة والأهداف 1R/2R/3R وتحريك الوقف محاكاة افتراضية من قراءات متباعدة 30 ثانية.
          السعر إرشادي من Gold API؛ تكاليف السبريد والانزلاق والعمولة تقديرات عامة لكل أونصة وليست رسوم وسيط فعلية.
          لا يوفّر المصدر bid/ask ولا ينفّذ التطبيق أوامر تداول.
          يجب أن يظل الخادم يعمل للتحديث والحفظ.
        </p>
      </aside>
      <footer>السعر بالدولار لكل أونصة تروي · Gold API · قاعدة البيانات المحلية: data/gold-signal.sqlite</footer>
    </main>
  );
}

function RecommendationCard({
  recommendation,
  account,
}: {
  recommendation: Recommendation;
  account: DashboardState["virtualAccount"] | null;
}) {
  const statusClass = recommendation.status === "open" ? "open" : recommendation.status;
  const closeReason = recommendation.closeReason === "take_profit_3"
    ? "إكمال الأهداف الثلاثة"
    : recommendation.closeReason === "take_profit"
      ? "بلوغ هدف الربح"
      : recommendation.closeReason === "stop_loss"
        ? "إغلاق عند وقف الخسارة"
        : recommendation.closeReason === "time_limit"
          ? "إغلاق محاكاة بعد 120 دقيقة"
        : "";

  return (
    <article className="recommendation-card">
      <div className="recommendation-title">
        <div>
          <strong>توصية #{recommendation.id}</strong>
          <span className={`direction-tag ${recommendation.direction}`}>{directionLabels[recommendation.direction]}</span>
        </div>
        <span className={`status-tag ${statusClass}`}>{statusLabels[recommendation.status]}</span>
      </div>
      <div className="recommendation-grid">
        <div><span>سعر الدخول</span><strong>${formatPrice(recommendation.entryPrice)}</strong></div>
        {recommendation.takeProfit1 !== null ? (
          <>
            <div><span>TP1 · 1R (ثلث الكمية)</span><strong>${formatPrice(recommendation.takeProfit1)}</strong></div>
            <div><span>TP2 · 2R (ثلث الكمية)</span><strong>${formatPrice(recommendation.takeProfit2 ?? recommendation.takeProfit)}</strong></div>
            <div><span>TP3 · 3R (الكمية المتبقية)</span><strong>${formatPrice(recommendation.takeProfit3 ?? recommendation.takeProfit)}</strong></div>
            <div>
              <span>الوقف الحالي · الابتدائي</span>
              <strong>
                ${formatPrice(recommendation.stopLoss)} · {recommendation.initialStopLoss === null ? "—" : `$${formatPrice(recommendation.initialStopLoss)}`}
              </strong>
            </div>
          </>
        ) : (
          <>
            <div><span>الهدف القديم</span><strong>${formatPrice(recommendation.takeProfit)}</strong></div>
            <div><span>وقف الخسارة</span><strong>${formatPrice(recommendation.stopLoss)}</strong></div>
          </>
        )}
        <div><span>المتوسط القصير</span><strong>${formatPrice(recommendation.shortAverage)}</strong></div>
        <div><span>المتوسط العام</span><strong>${formatPrice(recommendation.longAverage)}</strong></div>
        <div><span>تغير الإشارة</span><strong>{formatPercent(recommendation.changePercent)}</strong></div>
      </div>
      {recommendation.costEstimateModel && (
        <div className="trade-costs">
          <strong>تكاليف تقديرية عامة · لكل أونصة ذهابًا وعودة</strong>
          <span>
            سبريد {recommendation.estimatedSpreadUsdPerOunce === null ? "—" : formatCost(recommendation.estimatedSpreadUsdPerOunce)}
            {" · "}انزلاق {recommendation.estimatedSlippageUsdPerOunce === null ? "—" : formatCost(recommendation.estimatedSlippageUsdPerOunce)}
            {" · "}عمولة {recommendation.estimatedCommissionUsdPerOunce === null ? "—" : formatCost(recommendation.estimatedCommissionUsdPerOunce)}
          </span>
          {recommendation.resultPercent !== null && recommendation.estimatedNetResultPercent !== null && (
            <span>
              إجمالي {formatPercent(recommendation.resultPercent)}
              {" · "}صافي تقديري {formatPercent(recommendation.estimatedNetResultPercent)}
              {" · "}التكلفة الإجمالية {recommendation.estimatedTotalCostUsdPerOunce === null
                ? "—"
                : formatCost(recommendation.estimatedTotalCostUsdPerOunce)}
            </span>
          )}
        </div>
      )}
      {recommendation.accountEquityAtEntry !== null && (
        <div className="trade-dollars">
          <strong>نتيجة الحساب المحاكاة</strong>
          <span>
            الرصيد عند الدخول: ${formatPrice(recommendation.accountEquityAtEntry)}
            {account && ` · قاعدة $${account.lotStepUsd} مقابل ${account.lotStepSize} lot`}
            {" · "}الحجم الافتراضي {recommendation.virtualQuantityOunces === null || !account
              ? "—"
              : `${(recommendation.virtualQuantityOunces / account.ouncesPerLot).toFixed(2)} lot (${recommendation.virtualQuantityOunces.toFixed(2)} oz)`}
          </span>
          {recommendation.status !== "open" ? (
            <span>
              ربح إجمالي {formatDollar(recommendation.realizedGrossUsd)}
              {" · "}تكلفة تقديرية {formatDollar(-recommendation.estimatedCostUsd)}
              {" · "}صافي محقق {formatDollar(recommendation.realizedNetUsd)}
              {recommendation.accountEquityAfter !== null &&
                ` · الرصيد بعد الصفقة $${formatPrice(recommendation.accountEquityAfter)}`}
            </span>
          ) : (
            <span>الربح/الخسارة المحقق حتى الآن: {formatDollar(recommendation.realizedNetUsd)}</span>
          )}
        </div>
      )}
      <div className="recommendation-meta">
        <span>وقت الإنشاء: {formatDateTime(recommendation.createdAt)}</span>
        <span>المدة: {recommendation.durationMinutes} دقيقة</span>
        <span>السعر: {recommendation.priceSource} · XAU/USD</span>
        <span>الاستراتيجية: {recommendation.strategyVersion} · الإدارة: {recommendation.managementVersion}</span>
      </div>
      <div className="trade-observations">
        <span>
          أثناء الصفقة: {recommendation.openObservationCount} قراءة
          {recommendation.openObservedLow !== null && recommendation.openObservedHigh !== null
            ? ` · أدنى $${formatPrice(recommendation.openObservedLow)} / أعلى $${formatPrice(recommendation.openObservedHigh)}`
            : ""}
        </span>
        <span>
          بعد الإغلاق: {recommendation.postCloseObservationCount} قراءة
          {recommendation.postCloseObservedLow !== null && recommendation.postCloseObservedHigh !== null
            ? ` · أدنى $${formatPrice(recommendation.postCloseObservedLow)} / أعلى $${formatPrice(recommendation.postCloseObservedHigh)}`
            : ""}
        </span>
        <span>فجوات بيانات: {recommendation.dataGapCount}</span>
        {recommendation.observationCount > 0 && (
          <a href={`/api/recommendations/${recommendation.id}/observations.csv`} download>
            تنزيل سجل السعر CSV
          </a>
        )}
      </div>
      {recommendation.managementVersion === "r-3tp-v1" && (
        <div className="trade-progress">
          <span>
            المحقق الإجمالي قبل التكلفة: {formatPercent(recommendation.realizedPercent)}
            {" · "}المتبقي: {(recommendation.remainingFraction * 100).toFixed(1)}%
          </span>
          {recommendation.events.length > 0 && (
            <ul>
              {recommendation.events.map((event) => (
                <li key={event.id}>
                  <span>{formatTradeEvent(event)}</span>
                  <time>{formatDateTime(event.occurredAt)}</time>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {recommendation.closedAt && recommendation.exitPrice !== null && recommendation.resultPercent !== null && (
        <div className={`recommendation-result ${recommendation.status}`}>
          <span>{closeReason} · سعر الرصد ${formatPrice(recommendation.exitPrice)}</span>
          <strong>
            {formatPercent(recommendation.resultPercent)}
            {" · "}صافي محقق {formatDollar(recommendation.realizedNetUsd)}
            {" · "}{formatDateTime(recommendation.closedAt)}
          </strong>
        </div>
      )}
    </article>
  );
}

function NewsPanel({ newsGuard }: { newsGuard: NewsGuard }) {
  const statusLabel = newsGuard.status === "ready"
    ? newsGuard.blocked ? "توصيات جديدة متوقفة" : "التقويم متصل"
    : newsGuard.status === "not_configured"
      ? "غير مهيأ"
      : newsGuard.status === "loading"
        ? "جارٍ التحميل"
        : "التحقق غير متاح";

  return (
    <section className={`panel news-panel ${newsGuard.blocked ? "news-blocked" : ""}`}>
      <div className="activity-heading">
        <div>
          <p className="panel-label">فلتر مواعيد اقتصادية</p>
          <h2>تقويم الإصدارات الأمريكية · FRED</h2>
        </div>
        <span className={`status-tag ${newsGuard.blocked ? "failed" : "success"}`}>{statusLabel}</span>
      </div>
      <p className="news-message">{newsGuard.message}</p>
      {newsGuard.todayEvents.length > 0 && (
        <ul className="news-events today-events">
          {newsGuard.todayEvents.map((event) => (
            <li key={event.id}>
              <strong>{event.name}</strong>
              <span>{event.date} · توقيت الإصدار غير متوفر من المصدر</span>
            </li>
          ))}
        </ul>
      )}
      {newsGuard.upcomingEvents.length > 0 && (
        <div className="upcoming-news">
          <span>الإصدارات المهمة القادمة</span>
          <ul className="news-events">
            {newsGuard.upcomingEvents.map((event) => (
              <li key={event.id}>
                <strong>{event.name}</strong>
                <span>{event.date}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {newsGuard.details && <p className="news-error" role="status">{newsGuard.details}</p>}
      <small>
        القائمة تشمل إصدارات مختارة فقط؛ المصدر يوفر التاريخ دون ساعة الخبر أو التوقع والنتيجة، ولا يغطي مواعيد FOMC بدقة أو الأخبار العاجلة. لذلك يوقف التطبيق التوصيات الجديدة طوال يوم الإصدار بتوقيت نيويورك؛ الصفقات المفتوحة تظل تحت إدارة TP/SL.
        {newsGuard.status === "not_configured" && " للتفعيل، أضف FRED_API_KEY في ملف .env ثم أعد تشغيل الخادم."}
      </small>
    </section>
  );
}

function formatTradeEvent(event: RecommendationEvent) {
  // The API stores cost per ounce already weighted by the closed fraction.
  const perOunceCost = event.estimatedCostUsdPerOunce === null || event.quantityFraction <= 0
    ? null
    : event.estimatedCostUsdPerOunce / event.quantityFraction;
  const estimatedCost = perOunceCost === null
    ? ""
    : ` · تكلفة تقديرية ${formatCost(perOunceCost)}`;
  const netContribution = event.netContributionPercent === null
    ? ""
    : ` · مساهمة صافية تقديرية ${formatPercent(event.netContributionPercent)}`;
  const netLabel = event.netPnlUsd === null
    ? "صافي غير متاح"
    : `صافي ${formatDollar(event.netPnlUsd)}`;
  const dollarResult = event.grossPnlUsd === null
    ? ""
    : ` · نقاط ${event.pointMove === null ? "—" : `${event.pointMove >= 0 ? "+" : ""}${event.pointMove.toFixed(2)}`} · إجمالي ${formatDollar(event.grossPnlUsd)} · ${netLabel}`;
  if (event.eventType === "target_hit") {
    return `TP${event.targetNumber}: إغلاق ${(event.quantityFraction * 100).toFixed(1)}% عند $${formatPrice(event.price)} (إجمالي ${formatPercent(event.contributionPercent)})${estimatedCost}${netContribution}${dollarResult}`;
  }
  if (event.eventType === "stop_moved") {
    return `تحريك الوقف إلى $${formatPrice(event.currentStopLoss)} بعد TP${event.targetNumber}`;
  }
  if (event.eventType === "stopped_out") {
    return `إغلاق ${(event.quantityFraction * 100).toFixed(1)}% المتبقية بالوقف عند $${formatPrice(event.price)} (إجمالي ${formatPercent(event.contributionPercent)})${estimatedCost}${netContribution}${dollarResult}`;
  }
  if (event.targetNumber === null && event.quantityFraction > 0) {
    return `إغلاق زمني لمحاكاة الصفقة عند $${formatPrice(event.price)} (إجمالي ${formatPercent(event.contributionPercent)})${estimatedCost}${netContribution}${dollarResult}`;
  }
  return `إغلاق الصفقة عند $${formatPrice(event.price)}`;
}

function Sparkline({ points }: { points: PricePoint[] }) {
  const width = 720;
  const height = 190;
  const padding = 12;
  const values = points.map((point) => point.price);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const coordinates = values.map((value, index) => {
    const x = padding + (index / Math.max(values.length - 1, 1)) * (width - padding * 2);
    const y = padding + ((max - value) / range) * (height - padding * 2);
    return `${x},${y}`;
  });
  const rising = values[values.length - 1] >= values[0];
  const line = coordinates.join(" ");
  const area = `${padding},${height} ${line} ${width - padding},${height}`;

  return (
    <svg className={`sparkline ${rising ? "chart-rising" : "chart-falling"}`} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      <defs>
        <linearGradient id="chart-fill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity=".22" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={area} fill="url(#chart-fill)" />
      <polyline points={line} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export default App;
