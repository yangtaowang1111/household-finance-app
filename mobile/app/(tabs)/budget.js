import { useCallback, useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import { api, money } from '../../lib/api';
import { Row, Screen, Section, useTheme } from '../../lib/ui';
import { radius, space, type } from '../../lib/theme';

/* Budget, read-only on the phone.
 *
 * Setting a budget across fifty-nine categories is keyboard work and belongs on
 * the web version. What a phone is for is the other half of the question —
 * "am I over?" — answered while standing in a shop, which is exactly when it
 * matters and exactly when a laptop is not to hand. */
export default function Budget() {
  const c = useTheme();
  const [mode, setMode] = useState('month');
  const [state, setState] = useState({ loading: true, error: null, data: null });

  const load = useCallback(async (which) => {
    try {
      const now = new Date();
      const year = now.getFullYear();
      const query =
        which === 'month' ? `year=${year}&month=${now.getMonth() + 1}` : `year=${year}`;
      const data = await api(`/budgets/progress?${query}`);
      setState({ loading: false, error: null, data });
    } catch (err) {
      if (err.needsSetup) return router.push('/settings');
      setState({ loading: false, error: err.message, data: null });
    }
  }, []);

  useEffect(() => {
    load(mode);
  }, [mode, load]);

  const { loading, error, data } = state;
  if (!data) return <Screen loading={loading} error={error} onRefresh={() => load(mode)} />;

  const overspent = data.groups
    .flatMap((g) => g.categories)
    .filter((x) => x.over && x.budgeted)
    .sort((a, b) => a.remaining - b.remaining);

  return (
    <Screen loading={false} error={error} onRefresh={() => load(mode)}>
      {/* A segmented control, the platform's own idea of a two-way choice. */}
      <View
        style={{
          flexDirection: 'row',
          backgroundColor: c.lineSoft,
          borderRadius: radius.sm,
          padding: 2,
          marginBottom: space.xl,
        }}
      >
        {[
          ['month', 'This month'],
          ['ytd', 'Year to date'],
        ].map(([value, label]) => (
          <Pressable
            key={value}
            onPress={() => setMode(value)}
            style={{
              flex: 1,
              paddingVertical: space.sm,
              borderRadius: radius.sm - 2,
              backgroundColor: mode === value ? c.surface : 'transparent',
              alignItems: 'center',
            }}
          >
            <Text style={{ ...type.subhead, color: mode === value ? c.text : c.muted }}>{label}</Text>
          </Pressable>
        ))}
      </View>

      <Section title="Against plan">
        <Row label="Budgeted" value={money(data.budgeted)} valueColor={c.text} />
        <Row
          label="Spent"
          sub={data.used_percent === null ? undefined : `${data.used_percent}% used`}
          value={money(data.actual)}
          valueColor={c.text}
        />
        <Row
          label="Remaining"
          value={money(data.remaining)}
          valueColor={data.remaining < 0 ? c.attn : c.pos}
        />
        {data.unbudgeted_spending ? (
          <Row
            label="Unbudgeted"
            sub="spent where nothing was budgeted"
            value={money(data.unbudgeted_spending)}
            valueColor={c.attn}
          />
        ) : null}
      </Section>

      {overspent.length ? (
        <Section title="Over budget" footer="Sorted by how far over, not by size.">
          {overspent.slice(0, 10).map((x) => (
            <Row
              key={x.category_id}
              label={x.name}
              sub={`${money(x.actual)} of ${money(x.budgeted)}`}
              value={money(x.remaining)}
              valueColor={c.attn}
            />
          ))}
        </Section>
      ) : (
        <Section footer="Nothing is over its budget in this period.">
          <Row label="All categories within budget" value="✓" valueColor={c.pos} />
        </Section>
      )}

      <Section title="By group">
        {data.groups.map((g) => (
          <Row
            key={g.group_id}
            label={g.name}
            sub={`${money(g.actual)} of ${money(g.budgeted)}`}
            value={g.used_percent === null ? '—' : `${g.used_percent}%`}
            valueColor={g.over ? c.attn : c.muted}
          />
        ))}
      </Section>
    </Screen>
  );
}
