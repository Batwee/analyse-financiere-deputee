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

// Extrait la valeur numérique en parcourant TOUS les champs d'un nœud
function extractAnyNumericValue(obj) {
  if (!obj || typeof obj !== 'object') return 0;

  // Clés prioritaires de la HATVP
  const priorityKeys = [
    'evaluation', 'evaluationDto', 'valeur', 'valeurParticipation', 
    'remuneration', 'montant', 'capital'
  ];

  for (const key of priorityKeys) {
    if (obj[key] !== undefined && obj[key] !== null) {
      const parsed = parseStringValue(obj[key]);
      if (parsed > 0) return parsed;
    }
  }

  // Scan général de toutes les clés de l'objet
  for (const [key, val] of Object.entries(obj)) {
    if (key.toLowerCase().includes('nom') || key.toLowerCase().includes('societe')) continue;
    const parsed = parseStringValue(val);
    if (parsed > 0) return parsed;
  }

  return 0;
}

function parseStringValue(val) {
  if (val === undefined || val === null) return 0;
  if (typeof val === 'number') return val;
  if (typeof val === 'object') return extractAnyNumericValue(val);

  const valStr = String(val).trim();
  if (!valStr || valStr.toLowerCase() === 'neant' || valStr.toLowerCase() === 'false') return 0;

  const cleanVal = valStr.replace(/\s+/g, '');
  const matches = cleanVal.match(/\d+/);
  return matches ? parseFloat(matches[0]) : 0;
}

function isParlementaire(decla) {
  const jsonStr = JSON.stringify(decla).toLowerCase();
  return (
    jsonStr.includes('dép') ||
    jsonStr.includes('depu') ||
    jsonStr.includes('sénat') ||
    jsonStr.includes('senat') ||
    jsonStr.includes('assemblée nationale') ||
    jsonStr.includes('assemblee nationale')
  );
}

function getFinancialItems(partSection) {
  let items = [];
  if (!partSection) return items;

  function collect(node) {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach(collect);
    } else if (typeof node === 'object') {
      const nom = node.nomSociete || node.nom_societe || node.denomination;
      if (nom && typeof nom === 'string' && nom.trim().length > 0) {
        items.push(node);
      } else {
        for (const k of Object.keys(node)) {
          if (typeof node[k] === 'object') collect(node[k]);
        }
      }
    }
  }

  collect(partSection);
  return items;
}

function getEluNom(decla) {
  const declarant = decla?.declarant || {};
  const prenom = String(declarant.prenom || declarant.prenomDeclarant || '').trim();
  const nom = String(declarant.nom || declarant.nomDeclarant || '').trim();

  if (prenom || nom) return `${prenom} ${nom}`.trim();

  const generalNom = String(decla?.general?.declarant?.nom || '').trim();
  const generalPrenom = String(decla?.general?.declarant?.prenom || '').trim();
  if (generalNom || generalPrenom) return `${generalPrenom} ${generalNom}`.trim();

  return 'Inconnu';
}

function normalizeName(str) {
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .trim();
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
          deputesMap.set(keyName, {
            parti: d.parti_rattachement || d.groupe_sigle || 'Non renseigné'
          });
        }
      }
    } catch (e) {
      console.warn('API députés indisponible, bascule sur le XML.');
    }

    const xmlText = await downloadXML(XML_URL);
    console.log('Parsing du document XML...');

    const parser = new XMLParser({
      ignoreAttributes: false,
      parseNodeValue: false,
      isArray: (name) => ['declaration', 'items', 'item'].includes(name)
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
        parti = String(
          decla?.qualiteMandat?.organe?.codeOrgane ||
          decla?.qualiteMandat?.labelOrgane || 
          decla?.qualiteMandat?.organe?.label || 
          'Non renseigné'
        ).trim();
      }

      const partSection = decla?.participationsFinancieresDto;
      if (!partSection || partSection.neant === 'true' || partSection.neant === true) continue;

      const itemsFound = getFinancialItems(partSection);

      for (const item of itemsFound) {
        const nomSociete = String(
          item.nomSociete || item.nom_societe || item.denomination || ''
        ).trim().toUpperCase();

        if (!nomSociete) continue;

        const montant = extractAnyNumericValue(item);
        if (montant <= 0) continue;

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

    console.log(`Parlementaires identifiés : ${countParlementaires}`);
    console.log(`Participations financières extraites (> 0 €) : ${records.length}`);

    if (records.length === 0) {
      throw new Error("Aucune participation n'a été extraite.");
    }

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(records, null, 2), 'utf-8');
    console.log(`Fichier ${OUTPUT_FILE} généré avec succès (${records.length} entrées).`);

  } catch (error) {
    console.error('Erreur :', error.message);
    process.exit(1);
  }
}

processData();
