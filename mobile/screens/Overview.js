import { useCallback, useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { api, money } from '../lib/api';
import { Hero, Row, Screen, Section, useTheme } from '../lib/ui';
import { space, type } from '../lib/theme';

/* Overview. The same four questions the web version answers, ordered for a
   phone: net worth first because it is what you open the app to see, then this
   period's flow, then where the money went.
 *
 * The spending breakdown is the one place a phone genuinely beats the desktop â€”
 * a ranked list with a proportion bar reads better on a narrow screen than the
 * web version's two columns. */
export default function Overview({ onNeedsSetup }) {
  const c = useTheme();
  const [state, setState] = useState({ loading: true, error: null, data: null });

  const load = useCallback(async () => {
    try {
      const year = new Date().getFullYear();
      const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
      const [nw, cf] = await Promise.all([
        api('/networth'),
        api(`/cashflow?from=${year}-01-01&to=${tomorrow}`),
      ]);
      setState({ loading: false, error: null, data: { nw, cf, year } });
    } catch (err) {
      if (err.needsSetup) return onNeedsSetup && onNeedsSetup();
      setState({ loading: false, error: err.message, data: null });
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const { loading, error, data } = state;
  if (!data) return <Screen loading={loading} error={error} onRefresh={load} />;

  const { nw, cf, year } = data;
  const spending = cf.groups
    .filter((g) => g.counts_as_spending && g.total < 0)
    .sort((a, b) => a.total - b.total);
  const largest = spending.length ? Math.abs(spending[0].total) : 1;

  return (
    <Screen loading={false} error={error} onRefresh={load}>
      <Hero
        label="Net worth"
        value={money(nw.net_worth)}
        delta={`${money(nw.assets)} assets Â· ${money(nw.liabilities)} owed`}
      />

      <Section title={`${year} to date`}>
        <Row label="Income" value={money(cf.income)} valueColor={c.text} />
        <Row label="Spending" value={money(cf.spending)} valueColor={c.text} />
        <Row
          label="Surplus"
          sub={`${money(cf.saved)} moved to savings`}
          value={money(cf.surplus)}
          valueColor={cf.surplus < 0 ? c.attn : c.pos}
        />
        <Row
          label="Savings rate"
          sub="earned and not spent"
          value={cf.savings_rate === null ? 'â€”' : `${cf.savings_rate}%`}
          valueColor={c.text}
        />
      </Section>

      <Section title="Where it went" footer={`${money(cf.spending)} across ${spending.length} groups`}>
        {spending.map((g) => (
          <View key={g.group} style={{ paddingHorizontal: space.lg, paddingVertical: space.md }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
              <Text style={{ ...type.body, color: c.text }} numberOfLines={1}>
                {g.group}
              </Text>
              <Text style={{ ...type.body, ...type.figure, color: c.text }}>{money(-g.total)}</Text>
            </View>
            {/* Proportion against the largest group, not the total: at fourteen
                groups a share-of-total bar is a sliver for everything. */}
            <View style={{ height: 4, backgroundColor: c.lineSoft, borderRadius: 2 }}>
              <View
                style={{
                  height: 4,
                  borderRadius: 2,
                  backgroundColor: c.accent,
                  width: `${Math.max(2, (Math.abs(g.total) / largest) * 100)}%`,
                }}
              />
            </View>
          </View>
        ))}
      </Section>

      <Section title="Accounts">
        {nw.by_type.map((t) => (
          <Row
            key={t.type}
            label={t.type.charAt(0).toUpperCase() + t.type.slice(1)}
            sub={`${t.accounts} account${t.accounts === 1 ? '' : 's'}`}
            value={money(t.total)}
            valueColor={t.total < 0 ? c.attn : c.text}
          />
        ))}
      </Section>

      <Section footer="Pull down to refresh. Figures come straight from the NAS.">
        <Row label="Connection" value="Settings" onPress={onNeedsSetup} />
      </Section>
    </Screen>
  );
}
