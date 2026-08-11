import streamlit as st
import pandas as pd
import os

DATA_URL = "https://raw.githubusercontent.com/Batwee/analyse-financiere-deputee/refs/heads/main/hatvp_data.json"

# Configuration de la page Streamlit
st.set_page_config(
    page_title="HATVP — Participations Financières",
    page_icon="📊",
    layout="wide"
)

st.title("📊 Participations Financières des Parlementaires")
st.caption("Analyse des participations financières déclarées par les députés et sénateurs à la HATVP.")

# Charger le fichier JSON directement depuis GitHub ou en local
@st.cache_data
def load_data():
    try:
        return pd.read_json(DATA_URL)
    except Exception:
        if os.path.exists("hatvp_data.json"):
            return pd.read_json("hatvp_data.json")
        return None

df = load_data()

if df is None or df.empty:
    st.error("Impossible de charger les données depuis GitHub ou le fichier local `hatvp_data.json`.")
    st.stop()

# Nettoyage et préparation des données
df['montant'] = pd.to_numeric(df['montant'], errors='coerce').fillna(0)

# --- CALCULS ET AGREGATIONS ---
company_summary = df.groupby('entreprise').agg(
    montant_cumule=('montant', 'sum'),
    nb_elus=('elu', 'nunique')
).reset_index()

top_company_row = company_summary.sort_values(by='montant_cumule', ascending=False).iloc[0]
top_company_name = top_company_row['entreprise']
top_company_amount = top_company_row['montant_cumule']

pivot_parti = df.pivot_table(
    index='entreprise',
    columns='parti',
    values='montant',
    aggfunc='sum',
    fill_value=0
)

pivot_pct = pivot_parti.div(company_summary.set_index('entreprise')['montant_cumule'], axis=0) * 100

summary_df = company_summary.set_index('entreprise').join(pivot_pct).reset_index()
summary_df = summary_df.sort_values(by='montant_cumule', ascending=False)

# --- 1. CARTES KPI ---
col1, col2, col3, col4 = st.columns(4)

with col1:
    st.metric(
        label="🏆 Top Investissement Cumulé",
        value=f"{top_company_amount:,.0f} €".replace(",", " "),
        delta=top_company_name,
        delta_color="normal"
    )

with col2:
    st.metric(
        label="💰 Total Cumulé Global",
        value=f"{df['montant'].sum():,.0f} €".replace(",", " ")
    )

with col3:
    st.metric(
        label="🏢 Entreprises Déclarées",
        value=f"{df['entreprise'].nunique()}"
    )

with col4:
    st.metric(
        label="👥 Parlementaires Concernés",
        value=f"{df['elu'].nunique()}"
    )

st.markdown("---")

# --- 2. FILTRES SIDEBAR ---
st.sidebar.header("🔍 Filtres")

search_company = st.sidebar.text_input("Rechercher une entreprise", "").strip().upper()

types_dispo = df['type'].dropna().unique().tolist() if 'type' in df.columns else []
selected_types = st.sidebar.multiselect("Filtrer par mandat", options=types_dispo, default=types_dispo)

min_amount = st.sidebar.number_input(
    "Montant cumulé minimum (€)", 
    min_value=0, 
    value=0, 
    step=5000
)

filtered_df = df.copy()

if selected_types and 'type' in filtered_df.columns:
    filtered_df = filtered_df[filtered_df['type'].isin(selected_types)]

if search_company:
    filtered_df = filtered_df[filtered_df['entreprise'].str.contains(search_company, na=False)]

filtered_summary = filtered_df.groupby('entreprise').agg(
    montant_cumule=('montant', 'sum'),
    nb_elus=('elu', 'nunique')
).reset_index()

filtered_summary = filtered_summary[filtered_summary['montant_cumule'] >= min_amount]

filtered_pivot = filtered_df.pivot_table(
    index='entreprise',
    columns='parti',
    values='montant',
    aggfunc='sum',
    fill_value=0
)

filtered_pct = filtered_pivot.div(filtered_summary.set_index('entreprise')['montant_cumule'], axis=0) * 100

final_table = filtered_summary.set_index('entreprise').join(filtered_pct).reset_index()
final_table = final_table.sort_values(by='montant_cumule', ascending=False)

# --- 3. TABLEAU PRINCIPAL ---
st.subheader("📋 Répartition des montants par entreprise et partis (%)")

if final_table.empty:
    st.warning("Aucune entreprise ne correspond aux critères de recherche.")
else:
    column_configuration = {
        "entreprise": st.column_config.TextColumn("Entreprise", width="medium"),
        "montant_cumule": st.column_config.NumberColumn(
            "Montant Cumulé (€)",
            format="%d €",
            help="Total investi par tous les parlementaires dans cette entreprise"
        ),
        "nb_elus": st.column_config.NumberColumn(
            "Nb Élus",
            format="%d",
            help="Nombre d'élus distincts détenant des parts"
        )
    }

    party_columns = [col for col in final_table.columns if col not in ['entreprise', 'montant_cumule', 'nb_elus']]
    for parti in party_columns:
        column_configuration[parti] = st.column_config.NumberColumn(
            f"% {parti}",
            format="%.1f %%",
            help=f"Part attribuée au parti {parti}"
        )

    st.dataframe(
        final_table,
        column_config=column_configuration,
        hide_index=True,
        use_container_width=True,
        height=500
    )

# --- 4. DÉTAIL PAR ENTREPRISE ---
st.markdown("---")
st.subheader("🔍 Détail des actionnaires par entreprise")

selected_company_drill = st.selectbox(
    "Sélectionne une entreprise pour voir les élus investis :",
    options=final_table['entreprise'].unique() if not final_table.empty else []
)

if selected_company_drill:
    details = filtered_df[filtered_df['entreprise'] == selected_company_drill][['elu', 'parti', 'type', 'montant']]
    details = details.sort_values(by='montant', ascending=False)
    
    st.dataframe(
        details,
        column_config={
            "elu": "Nom de l'élu",
            "parti": "Parti Politique",
            "type": "Mandat",
            "montant": st.column_config.NumberColumn("Montant Investi (€)", format="%d €")
        },
        hide_index=True,
        use_container_width=True
    )
