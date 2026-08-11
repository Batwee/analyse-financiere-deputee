const fs = require('fs');
const https = require('https');
const { XMLParser } = require('fast-xml-parser');

const XML_URL = 'https://www.hatvp.fr/livraison/merge/declarations.xml';
const DEPUTES_API_URL = 'https://www.nosdeputes.fr/deputes/json';
const OUTPUT_FILE = 'hatvp_data.json';

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } 
        catch (e) { reject(e); }
      });
    }).on('error', err => reject(err));
  });
}

function downloadXML(url) {
  return new Promise((resolve, reject) => {
    console.log('Téléchargement du XML HATVP...');
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', err => reject(err));
  });
}

// Sécurise la lecture d'une chaîne de caractères face aux objets inattendus
function getString(val) {
  if (!val) return '';
  if (typeof val === 'string') return val;
  if (typeof val === 'number') return String(val);
  return '';
}

// Extracteur ultime : fouille dans n'importe quel objet/sous-objet pour trouver le vrai chiffre
function parseNumeric(val) {
  if (val === undefined || val === null || val === '') return 0;
  if (typeof val === 'number') return val;
  
  if (typeof val === 'string') {
    const clean = val.replace(/\s+/g, '').replace(',', '.');
    const match = clean.match(/\d+(\.\d+)?/);
    return match ? parseFloat(match[0]) : 0;
  }
  
  if (typeof val === 'object') {
    if (val.montant !== undefined) return parseNumeric(val.montant);
    if (val.valeur !== undefined) return parseNumeric(val.valeur);
    if (val.evaluation !== undefined) return parseNumeric(val.evaluation);
    
    // Si la structure est encore plus profonde, on scanne les clés
    for (const key of Object.keys(val)) {
      const res = parseNumeric(val[key]);
      if (res > 0) return res;
    }
  }
  
  return 0;
}

function isParlementaire(decla) {
  const qualite = JSON.stringify(
    decla?.qualiteMandat || decla?.general?.qualiteMandat || decla?.declarant?.qualiteMandat || ''
  ).toLowerCase();

  return (
    qualite.includes('depute') || qualite.includes('dép') ||
    qualite.includes('senat') || qualite.includes('sénat') ||
    qualite.includes('assemblee') || qualite.includes('assemblée')
  );
}

function getEluNom(decla) {
  const declarant = decla?.declarant || decla?.general?.declarant || {};
  const prenom = getString(declarant.prenom || declarant.prenomDeclarant).trim();
  const nom = getString(declarant.nom || declarant.nomDeclarant).trim();
  if (prenom || nom) return `${prenom} ${nom}`.trim();
  return 'Inconnu';
}

function normalizeName(str) {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().trim();
}

async function processData() {
  try {
    console.log('Chargement des données API Députés...');
    const deputesMap = new Map();
    try {
      const deputesData = await fetchJSON(DEPUTES_API_URL);
      if (deputesData?.deputes) {
        for (const entry of deputesData.deputes) {
          const d = entry.depute;
          const keyName = normalizeName(d.nom);
          deputesMap.set(keyName, { parti: d.parti_rattachement || d.groupe_sigle || 'Non renseigné' });
        }
      }
    } catch (e) {
      console.warn('API députés indisponible, bascule sur les données XML seules.');
    }

    const xmlText = await downloadXML(XML_URL);
    console.log('Parsing du document XML...');

    // LE SECRET EST ICI : ignoreAttributes simplifie toutes les balises complexes en texte brut
    const parser = new XMLParser({
      ignoreAttributes: true,
      parseTagValue: true 
    });

    const parsedObj = parser.parse(xmlText);
    const rootContainer = parsedObj?.declarations || parsedObj;
    let declarations = rootContainer?.declaration || [];

    if (!Array.isArray(declarations)) declarations = [declarations];

    const records = [];
    const setUnique = new Set();
    let countParlementaires = 0;

    for (const decla of declarations) {
      if (!isParlementaire(decla)) continue;

      const eluNom = getEluNom(decla);
      if (!eluNom || eluNom === 'Inconnu') continue;

      countParlementaires++;

      const normName = normalizeName(eluNom);
      const apiInfo = deputesMap.get(normName);

      let parti = apiInfo?.parti;
      if (!parti || parti === 'Non renseigné') {
        const organe = decla?.qualiteMandat?.organe || decla?.qualiteMandat;
        parti = getString(organe?.codeOrgane || organe?.labelOrgane || organe?.label || 'Non renseigné').trim();
      }

      // APLATISSEMENT TOTAL : on récupère tous les objets imbriqués de la déclaration
      const allNodes = [];
      function traverse(node) {
        if (!node || typeof node !== 'object') return;
        allNodes.push(node);
        for (const key of Object.keys(node)) {
          if (typeof node[key] === 'object') traverse(node[key]);
        }
      }
      traverse(decla);

      for (const node of allNodes) {
        // EMPREINTE 1 : Doit avoir un nom d'entreprise
        const nomSociete = getString(node.nomSociete || node.nom_societe || node.denomination).trim().toUpperCase();
        if (!nomSociete) continue;

        // EMPREINTE 2 : Doit avoir un champ d'évaluation du capital (exclut les simples salaires)
        let rawVal = node.evaluation;
        if (rawVal === undefined) rawVal = node.capitalDetenu;
        if (rawVal === undefined) rawVal = node.valeurParticipation;
        
        // S'il n'y a ni evaluation, ni capital, c'est probablement un mandat bénévole ou un salaire, on ignore
        if (rawVal === undefined) continue;

        const montant = parseNumeric(rawVal);

        // FILTRE STRICT : Uniquement les montants supérieurs à 0 €
        if (montant > 0) {
          const uniqueKey = `${eluNom}-${nomSociete}-${montant}`;
          if (setUnique.has(uniqueKey)) continue;
          setUnique.add(uniqueKey);

          records.push({
            entreprise: nomSociete,
            elu: eluNom,
            parti: parti,
            montant: montant
          });
        }
      }
    }

    console.log(`Parlementaires identifiés : ${countParlementaires}`);
    console.log(`Participations financières valides (> 0 €) : ${records.length}`);

    if (records.length === 0) {
      throw new Error("Aucune participation > 0 € n'a été extraite.");
    }

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(records, null, 2), 'utf-8');
    console.log(`Fichier ${OUTPUT_FILE} généré avec succès (${records.length} entrées).`);

  } catch (error) {
    console.error('Erreur :', error.message);
    process.exit(1);
  }
}

processData();
