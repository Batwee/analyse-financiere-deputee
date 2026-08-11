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
    console.log('Téléchargement du fichier XML HATVP...');
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', err => reject(err));
  });
}

function parseEvaluationMontant(item) {
  let rawVal = item.evaluation;

  if (rawVal === undefined || rawVal === null || rawVal === '') {
    rawVal = item.montant || item.valeur || '0';
  }

  if (typeof rawVal === 'object') {
    if (rawVal.evaluation) rawVal = rawVal.evaluation;
    else if (rawVal.montant) rawVal = rawVal.montant;
    else rawVal = JSON.stringify(rawVal);
  }

  const valStr = String(rawVal).trim();
  const cleanVal = valStr.replace(/\s+/g, '');
  const matches = cleanVal.match(/\d+/);
  return matches ? parseFloat(matches[0]) : 0;
}

// Filtre strict pour parlementaires (Députés / Sénateurs)
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

function extractParticipations(node) {
  let list = [];
  if (!node) return list;

  if (Array.isArray(node)) {
    for (const item of node) list.push(...extractParticipations(item));
  } else if (typeof node === 'object') {
    const nom = node.nomSociete || node.nom_societe;
    if (nom && typeof nom === 'string' && nom.trim().length > 0) {
      list.push(node);
    }
    for (const key of Object.keys(node)) {
      if (typeof node[key] === 'object') {
        list.push(...extractParticipations(node[key]));
      }
    }
  }
  return list;
}

function getEluNom(decla) {
  const declarant = decla?.declarant || {};
  const prenom = String(declarant.prenom || declarant.prenomDeclarant || '').trim();
  const nom = String(declarant.nom || declarant.nomDeclarant || '').trim();

  if (prenom || nom) {
    return `${prenom} ${nom}`.trim();
  }

  const generalNom = String(decla?.general?.declarant?.nom || '').trim();
  const generalPrenom = String(decla?.general?.declarant?.prenom || '').trim();
  if (generalNom || generalPrenom) {
    return `${generalPrenom} ${generalNom}`.trim();
  }

  return 'Inconnu';
}

// Normalise les chaînes pour la comparaison de noms (ex: DAMIEN ABAD)
function normalizeName(str) {
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .trim();
}

async function processData() {
  try {
    // 1. Récupération du référentiel des députés (API OpenData NosDéputés / AN)
    console.log('Chargement des données API Députés...');
    const deputesMap = new Map();
    try {
      const deputesData = await fetchJSON(DEPUTES_API_URL);
      if (deputesData?.deputes) {
        for (const entry of deputesData.deputes) {
          const d = entry.depute;
          const keyName = normalizeName(d.nom);
          deputesMap.set(keyName, {
            parti: d.parti_rattachement || d.groupe_sigle || 'Non renseigné',
            mandat: 'Député'
          });
        }
      }
    } catch (e) {
      console.warn('Impossible de joindre l\'API députés, fallback sur les données XML.', e.message);
    }

    // 2. Téléchargement du XML HATVP
    const xmlText = await downloadXML(XML_URL);
    console.log('Parsing XML...');

    const parser = new XMLParser({
      ignoreAttributes: false,
      parseNodeValue: false,
      isArray: (name) => ['declaration', 'items', 'item'].includes(name)
    });

    const parsedObj = parser.parse(xmlText);
    const rootContainer = parsedObj?.declarations || parsedObj;
    let declarations = rootContainer?.declaration || [];

    if (!Array.isArray(declarations)) {
      declarations = [declarations];
    }

    const records = [];
    let countParlementaires = 0;

    for (const decla of declarations) {
      if (!isParlementaire(decla)) continue;

      const eluNom = getEluNom(decla);
      if (!eluNom || eluNom === 'Inconnu') continue;

      countParlementaires++;

      // Recherche du parti via l'API en priorité
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

      const itemsFound = extractParticipations(decla);

      for (const item of itemsFound) {
        const nomSociete = String(item.nomSociete || item.nom_societe || '').trim().toUpperCase();
        if (!nomSociete) continue;

        const montant = parseEvaluationMontant(item);

        records.push({
          entreprise: nomSociete,
          elu: eluNom,
          parti: parti,
          montant: montant
        });
      }
    }

    console.log(`Parlementaires identifiés : ${countParlementaires}`);
    console.log(`Participations financières extraites : ${records.length}`);

    if (records.length === 0) {
      throw new Error("Aucune participation n'a été extraite.");
    }

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(records, null, 2), 'utf-8');
    console.log(`Fichier ${OUTPUT_FILE} généré avec succès.`);

  } catch (error) {
    console.error('Erreur :', error.message);
    process.exit(1);
  }
}

processData();
