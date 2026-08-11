const fs = require('fs');
const https = require('https');
const { XMLParser } = require('fast-xml-parser');

const XML_URL = 'https://www.hatvp.fr/livraison/merge/declarations.xml';
const DEPUTES_API_URL = 'https://www.nosdeputes.fr/deputes/json';
const SENATEURS_API_URL = 'https://www.nossenateurs.fr/senateurs/json';
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
    console.log('Téléchargement du XML HATVP (cela peut prendre quelques secondes)...');
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', err => reject(err));
  });
}

function getString(val) {
  if (!val) return '';
  if (typeof val === 'string') return val;
  if (typeof val === 'number') return String(val);
  return '';
}

// Fonction pour nettoyer et unifier les noms des entreprises
function standardizeCompanyName(name) {
  if (!name) return '';

  // 1. Suppression des sauts de ligne et de la balise de caviardage
  let n = name.replace(/\[DONNÉES NON PUBLIÉES\]/gi, ' ')
              .replace(/\[DONNEES NON PUBLIEES\]/gi, ' ')
              .replace(/[\n\r]/g, ' ')
              .replace(/\s+/g, ' ')
              .trim()
              .toUpperCase();

  // 2. Unification TOTAL
  if (
    n.includes('TOTALENERGIE') || 
    n.includes('TOTAL ENERGIE') || 
    n.includes('TOTALÉNERGIE') || 
    n === 'TOTAL ENERGIES SE' || 
    n === 'TOTAL'
  ) {
    return 'TOTAL';
  }

  // 3. Unification CREDIT AGRICOLE (inclut les "CAISSE LOCALE CREDIT AGRICOLE", etc.)
  if (n.includes('CREDIT AGRICOLE') || n.includes('CRÉDIT AGRICOLE')) {
    return 'CREDIT AGRICOLE';
  }

  // 4. Unification HERMES
  if (n === 'HERMES INTERNATIONAL' || n === 'HERMES INTL' || n === 'HERMÈS INTERNATIONAL') {
    return 'HERMES';
  }

  // 5. Unification AIRBUS
  if (n === 'AIRBUS SE') {
    return 'AIRBUS';
  }

  return n;
}

// Extrait la valeur numérique des objets imbriqués
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
    
    for (const key of Object.keys(val)) {
      const res = parseNumeric(val[key]);
      if (res > 0) return res;
    }
  }
  return 0;
}

function getEluNom(decla) {
  const declarant = decla?.declarant || decla?.general?.declarant || {};
  let prenom = getString(declarant.prenom || declarant.prenomDeclarant).split(',')[0].trim();
  let nom = getString(declarant.nom || declarant.nomDeclarant).trim();
  
  if (prenom || nom) return `${prenom} ${nom}`.trim();
  return 'Inconnu';
}

function normalizeName(str) {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().trim();
}

async function processData() {
  try {
    const parlementairesMap = new Map();
    console.log('Chargement des listes officielles (Députés & Sénateurs)...');
    
    try {
      const depData = await fetchJSON(DEPUTES_API_URL);
      if (depData?.deputes) {
        for (const entry of depData.deputes) {
          const d = entry.depute;
          parlementairesMap.set(normalizeName(d.nom), { 
            parti: d.groupe_sigle || 'Non renseigné',
            type: 'Député'
          });
        }
      }
    } catch (e) { console.warn('Erreur API Députés'); }

    try {
      const senData = await fetchJSON(SENATEURS_API_URL);
      if (senData?.senateurs) {
        for (const entry of senData.senateurs) {
          const s = entry.senateur;
          parlementairesMap.set(normalizeName(s.nom), { 
            parti: s.groupe_sigle || 'Non renseigné',
            type: 'Sénateur'
          });
        }
      }
    } catch (e) { console.warn('Erreur API Sénateurs'); }

    console.log(`-> ${parlementairesMap.size} parlementaires officiels indexés.`);

    const xmlText = await downloadXML(XML_URL);
    console.log('Parsing du document XML...');

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
    let countMatched = 0;

    for (const decla of declarations) {
      const eluNom = getEluNom(decla);
      if (!eluNom || eluNom === 'Inconnu') continue;

      const normName = normalizeName(eluNom);
      if (!parlementairesMap.has(normName)) continue;

      countMatched++;
      const apiInfo = parlementairesMap.get(normName);
      const parti = apiInfo.parti;

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
        // APPLICATION DE LA FONCTION DE NETTOYAGE ICI
        const rawNom = getString(node.nomSociete || node.nom_societe || node.denomination);
        const nomSociete = standardizeCompanyName(rawNom);
        
        if (!nomSociete) continue;

        let rawVal = node.evaluation;
        if (rawVal === undefined) rawVal = node.capitalDetenu;
        if (rawVal === undefined) rawVal = node.valeurParticipation;
        
        if (rawVal === undefined) continue;

        const montant = parseNumeric(rawVal);

        if (montant > 0) {
          const uniqueKey = `${eluNom}-${nomSociete}-${montant}`;
          if (setUnique.has(uniqueKey)) continue;
          setUnique.add(uniqueKey);

          records.push({
            entreprise: nomSociete,
            elu: eluNom,
            parti: parti,
            type: apiInfo.type,
            montant: montant
          });
        }
      }
    }

    console.log(`Déclarations de parlementaires trouvées dans la HATVP : ${countMatched}`);
    console.log(`Participations financières extraites (> 0 €) : ${records.length}`);

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
