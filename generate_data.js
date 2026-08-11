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

// Extraction précise selon les schémas réels du XML HATVP
function getMontantParticipation(item) {
  if (!item) return 0;

  // 1. Cas direct : champ evaluation / evaluationDto
  let raw = item.evaluation;
  if (raw === undefined || raw === null || raw === '') {
    raw = item.valeur || item.valeurParticipation || item.montant;
  }

  // 2. Si c'est un objet (ex: <evaluation><montant><montant>15000</montant></montant></evaluation>)
  if (typeof raw === 'object' && raw !== null) {
    if (raw.montant !== undefined) raw = raw.montant;
    if (typeof raw === 'object' && raw !== null && raw.montant !== undefined) raw = raw.montant;
    if (typeof raw === 'object' && raw !== null && raw.valeur !== undefined) raw = raw.valeur;
  }

  // 3. Fallback : si l'évaluation est dans le tableau de rémunération/évaluation sous l'item
  if ((raw === undefined || raw === null || raw === '' || raw === 0) && item.remuneration) {
    const rem = item.remuneration;
    if (rem.montant) {
      const montants = Array.isArray(rem.montant) ? rem.montant : [rem.montant];
      let total = 0;
      for (const m of montants) {
        const v = typeof m === 'object' ? (m.montant || m.valeur) : m;
        const parsed = parseString(v);
        if (parsed > total) total = parsed; // On prend la valeur/évaluation la plus récente
      }
      if (total > 0) return total;
    }
  }

  return parseString(raw);
}

function parseString(val) {
  if (val === undefined || val === null) return 0;
  if (typeof val === 'number') return val;
  const str = String(val).replace(/\s+/g, '').replace(',', '.');
  const match = str.match(/\d+(\.\d+)?/);
  return match ? parseFloat(match[0]) : 0;
}

function isParlementaire(decla) {
  const qualite = JSON.stringify(
    decla?.qualiteMandat || decla?.general?.qualiteMandat || decla?.declarant?.qualiteMandat || ''
  ).toLowerCase();

  return (
    qualite.includes('depute') ||
    qualite.includes('dép') ||
    qualite.includes('senat') ||
    qualite.includes('sénat') ||
    qualite.includes('assemblee') ||
    qualite.includes('assemblée')
  );
}

function extractItems(node) {
  let list = [];
  if (!node) return list;

  if (Array.isArray(node)) {
    for (const child of node) list.push(...extractItems(child));
  } else if (typeof node === 'object') {
    const nom = node.nomSociete || node.nom_societe || node.denomination;
    if (nom && typeof nom === 'string' && nom.trim().length > 0) {
      list.push(node);
    } else {
      for (const k of Object.keys(node)) {
        if (typeof node[k] === 'object') list.push(...extractItems(node[k]));
      }
    }
  }
  return list;
}

function getEluNom(decla) {
  const declarant = decla?.declarant || decla?.general?.declarant || {};
  const prenom = String(declarant.prenom || declarant.prenomDeclarant || '').trim();
  const nom = String(declarant.nom || declarant.nomDeclarant || '').trim();

  if (prenom || nom) return `${prenom} ${nom}`.trim();
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
      console.warn('API députés indisponible, bascule sur les données XML.');
    }

    const xmlText = await downloadXML(XML_URL);
    console.log('Parsing du document XML...');

    const parser = new XMLParser({
      ignoreAttributes: false,
      parseNodeValue: false,
      isArray: (name) => ['declaration', 'items', 'item', 'montant'].includes(name)
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

      const sectionFinanciere = decla?.participationsFinancieresDto;
      if (!sectionFinanciere || sectionFinanciere.neant === 'true' || sectionFinanciere.neant === true) {
        continue;
      }

      const itemsFound = extractItems(sectionFinanciere);

      for (const item of itemsFound) {
        const nomSociete = String(
          item.nomSociete || item.nom_societe || item.denomination || ''
        ).trim().toUpperCase();

        if (!nomSociete) continue;

        const montant = getMontantParticipation(item);

        // FILTRE STRICT : On ne garde que ce qui est strictement > 0 €
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
