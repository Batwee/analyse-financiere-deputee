import streamlit as st
import pandas as pd
import yfinance as yf
import os

DATA_URL = "https://raw.githubusercontent.com/Batwee/analyse-financiere-deputee/refs/heads/main/hatvp_data.json"

# Configuration de la page Streamlit
st.set_page_config(
    page_title="HATVP — Participations Financières & Bourse",
    page_icon="📈",
    layout="wide"
)

st.title("📊 Participations Financières des Parlementaires & Impacts Boursiers")
st.caption("Analyse des participations financières déclarées par les députés et sénateurs à la HATVP et leur exposition aux marchés boursiers.")

# --- FONCTION DE FORMATAGE MONÉTAIRE ---
def fmt_eur(val):
    """Formate un nombre en euros avec un espace comme séparateur de milliers (ex: 2 917 742 €)."""
    try:
        return f"{float(val):,.0f} €".replace(",", " ")
    except (ValueError, TypeError):
        return "0 €"

# --- MAPPING ET RECONNAISSANCE BOURSIÈRE ---

KNOWN_LISTED = [
    "TOTAL", "TOTALENERGIES", "LVMH", "SANOFI", "AIR LIQUIDE", "SCHNEIDER", "HERMES", 
    "BNP", "PARIBAS", "VINCI", "AXA", "DANONE", "PERNOD", "SAFRAN", "ESSILOR", "L'OREAL", 
    "LOREAL", "AIRBUS", "STELLANTIS", "ORANGE", "ENGIE", "CAPGEMINI", "KERING", "MICHELIN", 
    "SAINT-GOBAIN", "CREDIT AGRICOLE", "SOCIETE GENERALE", "THALES", "PUBLICIS", "VEOLIA", 
    "CARREFOUR", "LEGRAND", "BOUYGUES", "TELEPERFORMANCE", "UNIBAIL", "ALSTOM", "EDENRED", 
    "EIFFAGE", "RENAULT", "DASSAULT", "VIVENDI", "GETLINK", "ARKEMA", "ACCOR", "SPIE", 
    "APPLE", "MICROSOFT", "AMAZON", "TESLA", "ALPHABET", "NVIDIA", "NOVO NORDISK", "ASML", "SHELL"
]

@st.cache_data(ttl=86400)
def check_if_listed(company_name):
    """Vérifie si une entreprise est cotée en bourse via mots-clés + Yahoo Finance API."""
    name_upper = str(company_name).upper().strip()
    
    # Exclusion des faux positifs : structures foncières, immobilières et statuts juridiques non cotés
    mots_exclus = [
        "SCI", "S.C.I.", "S.C.I", "SCPI", "SARL", "SAS", "EURL", 
        "SOCIETE CIVILE IMMOBILIERE", "GFR", "GFA", "GFV", "GFF", 
        "GROUPEMENT FONCIER", "GROUPEMENT FONCIER RURAL", "GROUPEMENT FONCIER AGRICOLE"
    ]
    words = name_upper.split()
    
    if any(mot in words for mot in mots_exclus) or name_upper in mots_exclus:
        return False
    
    # 1. Liste Euronext / CAC40
    for kw in KNOWN_LISTED:
        if kw in name_upper:
            return True
            
    # 2. Yahoo Finance API
    try:
        if len(name_upper) <= 10:
            ticker = yf.Ticker(name_upper)
            hist = ticker.history(period="1d")
            if not hist.empty:
                return True
    except Exception:
        pass
        
    return False

def classify_bloc(parti):
    """Classe les partis politiques dans les blocs Gauche, Droite / Majorité ou Autres."""
    p = str(parti).upper().strip()
    
    gauche_keywords = ['LFI', 'SOC', 'PS', 'ECO', 'EELV', 'GDR', 'NFP', 'PCF', 'G.S']
    droite_keywords = ['RN', 'REN', 'EPR', 'RE', 'LR', 'DR', 'UDR', 'HOR', 'DEM', 'MODEM', 'UDI', 'REC']
    
    if any(k in p for k in gauche_keywords):
        return '🔴 Gauche (LFI, SOC, Éco, GDR...)'
    elif any(k in p for k in droite_keywords):
        return '🔵 Droite & Majorité (RN, REN, UDR, DR, DEM, HOR...)'
    else:
        return '⚪ Autres / Indépendants (LIOT, NI...)'

# --- CHARGEMENT DES DONNÉES ---
@st.cache_data
def load_data():
    try:
        df = pd.read_json(DATA_URL)
    except Exception:
        if os.path.exists("hatvp_data.json"):
            df = pd.read_json("hatvp_data.json")
        else:
            return None

    df['montant'] = pd.to_numeric(df['montant'], errors='coerce').fillna(0)
    df['is_listed'] = df['entreprise'].apply(check_if_listed)
    df['bloc_politique'] = df['parti'].apply(classify_bloc)
    return df

df = load_data()

if df is None or df.empty:
    st.error("Impossible de charger les données.")
    st.stop()

# --- FILTRES SIDEBAR ---
st.sidebar.header("🔍 Filtres & Options")

filter_listed = st.sidebar.checkbox(
    "📈 Entreprises cotées en bourse uniquement", 
    value=True,
    help="Affiche uniquement les entreprises cotées dont l'évaluation varie selon les décisions politiques, lois et votes à l'Assemblée."
)

search_company = st.sidebar.text_input("Rechercher une entreprise", "").strip().upper()

types_dispo = df['type'].dropna().unique().tolist() if 'type' in df.columns else []
selected_types = st.sidebar.multiselect("Filtrer par mandat", options=types_dispo, default=types_dispo)

filtered_df = df.copy()

if filter_listed:
    filtered_df = filtered_df[filtered_df['is_listed'] == True]

if selected_types and 'type' in filtered_df.columns:
    filtered_df = filtered_df[filtered_df['type'].isin(selected_types)]

if search_company:
    filtered_df = filtered_df[filtered_df['entreprise'].str.contains(search_company, na=False)]

# --- KPIS EN HAUT ---
col1, col2, col3, col4 = st.columns(4)

total_invested = filtered_df['montant'].sum()

company_summary = filtered_df.groupby('entreprise').agg(montant_cumule=('montant', 'sum')).reset_index()
if not company_summary.empty:
    top_row = company_summary.sort_values(by='montant_cumule', ascending=False).iloc[0]
    top_company_name = top_row['entreprise']
    top_company_amount = top_row['montant_cumule']
else:
    top_company_name, top_company_amount = "N/A", 0

with col1:
    st.metric(
        label="🏆 Top Investissement Cumulé",
        value=fmt_eur(top_company_amount),
        delta=top_company_name,
        delta_color="normal"
    )

with col2:
    st.metric(
        label="💰 Total Cumulé Filtré",
        value=fmt_eur(total_invested)
    )

with col3:
    st.metric(
        label="🏢 Entreprises Concernées",
        value=f"{filtered_df['entreprise'].nunique()}"
    )

with col4:
    st.metric(
        label="👥 Parlementaires Investis",
        value=f"{filtered_df['elu'].nunique()}"
    )

st.markdown("---")

# --- SECTION 1 : INVESTISSEMENT PAR BLOC POLITIQUE ---
st.subheader("⚖️ Répartition Globale : Gauche vs Droite")

bloc_summary = filtered_df.groupby('bloc_politique').agg(
    montant_total=('montant', 'sum'),
    nb_elus=('elu', 'nunique')
).reset_index()

if total_invested > 0:
    bloc_summary['pourcentage'] = (bloc_summary['montant_total'] / total_invested) * 100
else:
    bloc_summary['pourcentage'] = 0

bloc_summary = bloc_summary.sort_values(by='montant_total', ascending=False)
bloc_summary['montant_total'] = bloc_summary['montant_total'].apply(fmt_eur)

st.dataframe(
    bloc_summary,
    column_config={
        "bloc_politique": st.column_config.TextColumn("Bloc Politique"),
        "montant_total": st.column_config.TextColumn("Montant Total (€)"),
        "pourcentage": st.column_config.NumberColumn("Part (%)", format="%.2f %%"),
        "nb_elus": st.column_config.NumberColumn("Nombre d'élus", format="%d")
    },
    hide_index=True,
    use_container_width=True
)

st.markdown("---")

# --- SECTION 2 : INVESTISSEMENT PAR PARTI POLITIQUE ---
st.subheader("🏛️ Répartition Globale par Parti Politique")

parti_summary = filtered_df.groupby('parti').agg(
    montant_total=('montant', 'sum'),
    nb_elus=('elu', 'nunique')
).reset_index()

if total_invested > 0:
    parti_summary['pourcentage'] = (parti_summary['montant_total'] / total_invested) * 100
else:
    parti_summary['pourcentage'] = 0

parti_summary = parti_summary.sort_values(by='montant_total', ascending=False)
parti_summary['montant_total'] = parti_summary['montant_total'].apply(fmt_eur)

st.dataframe(
    parti_summary,
    column_config={
        "parti": st.column_config.TextColumn("Parti Politique"),
        "montant_total": st.column_config.TextColumn("Montant Total (€)"),
        "pourcentage": st.column_config.NumberColumn("Part (%)", format="%.2f %%"),
        "nb_elus": st.column_config.NumberColumn("Nombre d'Élus", format="%d")
    },
    hide_index=True,
    use_container_width=True
)

st.info(f"💡 **Montant total des investissements cumulés analysés :** `{fmt_eur(total_invested)}`")

st.markdown("---")

# --- SECTION 3 : TABLEAU PAR ENTREPRISE ET VENTILATION PARTIS (%) ---
st.subheader("📋 Entreprises & Ventilation des Investissements par Parti (%)")

if filtered_df.empty:
    st.warning("Aucune entreprise ne correspond aux critères sélectionnés.")
else:
    comp_summary = filtered_df.groupby('entreprise').agg(
        montant_cumule=('montant', 'sum'),
        nb_elus=('elu', 'nunique')
    ).reset_index()

    pivot_parti = filtered_df.pivot_table(
        index='entreprise',
        columns='parti',
        values='montant',
        aggfunc='sum',
        fill_value=0
    )

    pivot_pct = pivot_parti.div(comp_summary.set_index('entreprise')['montant_cumule'], axis=0) * 100

    final_table = comp_summary.set_index('entreprise').join(pivot_pct).reset_index()
    final_table = final_table.sort_values(by='montant_cumule', ascending=False)
    
    final_table['montant_cumule'] = final_table['montant_cumule'].apply(fmt_eur)

    col_config = {
        "entreprise": st.column_config.TextColumn("Entreprise", width="medium"),
        "montant_cumule": st.column_config.TextColumn("Montant Cumulé (€)"),
        "nb_elus": st.column_config.NumberColumn("Nb Élus", format="%d")
    }

    party_cols = [c for c in final_table.columns if c not in ['entreprise', 'montant_cumule', 'nb_elus']]
    for p in party_cols:
        col_config[p] = st.column_config.NumberColumn(f"% {p}", format="%.1f %%")

    st.dataframe(
        final_table,
        column_config=col_config,
        hide_index=True,
        use_container_width=True,
        height=450
    )

# --- SECTION 4 : DRILL-DOWN PAR ENTREPRISE ---
st.markdown("---")
st.subheader("🔍 Détail des actionnaires par entreprise")

if not filtered_df.empty:
    selected_company = st.selectbox(
        "Sélectionne une entreprise pour voir les parlementaires investis :",
        options=comp_summary.sort_values(by='montant_cumule', ascending=False)['entreprise'].unique()
    )

    if selected_company:
        details = filtered_df[filtered_df['entreprise'] == selected_company][['elu', 'parti', 'type', 'montant']]
        details = details.sort_values(by='montant', ascending=False)
        details['montant'] = details['montant'].apply(fmt_eur)

        st.dataframe(
            details,
            column_config={
                "elu": "Nom de l'Élu",
                "parti": "Parti Politique",
                "type": "Mandat",
                "montant": st.column_config.TextColumn("Montant Investi (€)")
            },
            hide_index=True,
            use_container_width=True
        )
