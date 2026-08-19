import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Text, TextInput, View, useColorScheme } from 'react-native';
import { router } from 'expo-router';
import { api, money, shortDate } from '../../lib/api';
import { colors, radius, space, type } from '../../lib/theme';

/* Transactions. A FlatList rather than the Screen wrapper: two and a half
   thousand rows have to virtualise, and a ScrollView would render them all.
 *
 * Search is debounced and runs on the server, because the phone should not hold
 * the whole ledger to filter it. */
export default function Transactions() {
  const c = colors(useColorScheme());
  const [search, setSearch] = useState('');
  const [state, setState] = useState({ loading: true, error: null, rows: [] });

  const load = useCallback(async (term) => {
    try {
      const query = term ? `search=${encodeURIComponent(term)}&limit=200` : 'limit=200';
      setState((s) => ({ ...s, error: null }));
      const rows = await api(`/transactions?${query}`);
      setState({ loading: false, error: null, rows });
    } catch (err) {
      if (err.needsSetup) return router.push('/settings');
      setState({ loading: false, error: err.message, rows: [] });
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => load(search.trim()), search ? 300 : 0);
    return () => clearTimeout(timer);
  }, [search, load]);

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <View style={{ padding: space.lg, paddingBottom: space.sm }}>
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Search descriptions and notes"
          placeholderTextColor={c.muted}
          autoCorrect={false}
          autoCapitalize="none"
          clearButtonMode="while-editing"
          style={{
            backgroundColor: c.surface,
            borderRadius: radius.md,
            paddingHorizontal: space.md,
            paddingVertical: space.md,
            color: c.text,
            ...type.body,
          }}
        />
      </View>

      {state.error ? (
        <View style={{ margin: space.lg, padding: space.lg, backgroundColor: c.attnSoft, borderRadius: radius.md }}>
          <Text style={{ ...type.subhead, color: c.text }}>{state.error}</Text>
        </View>
      ) : null}

      {state.loading ? (
        <ActivityIndicator color={c.muted} style={{ marginTop: space.xl }} />
      ) : (
        <FlatList
          data={state.rows}
          keyExtractor={(t) => String(t.id)}
          contentInsetAdjustmentBehavior="automatic"
          keyboardDismissMode="on-drag"
          ItemSeparatorComponent={() => (
            <View style={{ height: 1, backgroundColor: c.lineSoft, marginLeft: space.lg }} />
          )}
          ListEmptyComponent={
            <Text style={{ ...type.subhead, color: c.muted, textAlign: 'center', marginTop: space.xl }}>
              Nothing matches.
            </Text>
          }
          ListFooterComponent={
            state.rows.length >= 200 ? (
              <Text style={{ ...type.footnote, color: c.muted, textAlign: 'center', padding: space.lg }}>
                Showing the most recent 200. Search to narrow it.
              </Text>
            ) : null
          }
          renderItem={({ item: t }) => (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: space.md,
                paddingVertical: space.md,
                paddingHorizontal: space.lg,
                backgroundColor: c.surface,
              }}
            >
              <View style={{ flex: 1 }}>
                <Text style={{ ...type.body, color: c.text }} numberOfLines={1}>
                  {t.payee || t.merchant_raw || '—'}
                </Text>
                <Text style={{ ...type.footnote, color: c.muted, marginTop: 1 }} numberOfLines={1}>
                  {shortDate(t.date)}, {t.date.slice(0, 4)}
                  {t.category_group ? ` · ${t.category_group}` : ' · uncategorised'}
                  {t.pending ? ' · pending' : ''}
                </Text>
              </View>
              <Text
                style={{
                  ...type.body,
                  ...type.figure,
                  color: t.amount > 0 ? c.pos : c.text,
                }}
              >
                {money(t.amount, { showPlus: true, cents: true })}
              </Text>
            </View>
          )}
        />
      )}
    </View>
  );
}
