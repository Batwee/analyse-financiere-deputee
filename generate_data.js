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

// Nettoie et extrait le montant de la participation
function parseEvaluationMontant(item) {
  let rawVal = item.evaluation;
  if (rawVal === undefined || rawVal === null || rawVal === '') {
    rawVal = item.montant || item.valeur || item.valeurParticipation || '0';
  }

  if (typeof rawVal === 'object') {
    rawVal = rawVal.evaluation || rawVal.montant || rawVal.valeur || JSON.stringify(rawVal);
  }

  const valStr = String(rawVal).trim();
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

// Détection souple des entreprises dans n'importe quelle sous-structure
function findParticipationsInTree(obj) {
  let results = [];
  if (!obj) return results;

  if (Array.isArray(obj)) {
    for (const child of obj) {
      results.push(...findParticipationsInTree(child));
    }
  } else if (typeof obj === 'object') {
    // Si l'objet possède un nom de société ou d'organisme
    const nom = obj.nomSociete || obj.nom_societe || obj.denomination || obj.nomOrganisme;
    if (nom && typeof nom === 'string' && nom.trim().length > 0) {
      results.push(obj);
    } else {
      for (const key of Object.keys(obj)) {
        if (typeof obj[key] === 'object') {
          results.push(...findParticipationsInTree(obj[key]));
        }
      }
    }
  }
  return results;
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
      console.warn('API députés indisponible, bascule sur les données du XML.');
    }

    const xmlText = await downloadXML(XML_URL);
    console.log('Parsing du document XML...');

    const parser = new XMLParser({
      ignoreAttributes: false,
      parseNodeValue: false,
      // Forcer toutes ces balises récurrentes à être des tableaux JS
      isArray: (name) => ['declaration', 'items', 'item', 'participationsFinancieresDto'].includes(name)
    });

    const parsedObj = parser.parse(xmlText);
    const rootContainer = parsedObj?.declarations || parsedObj;
    let declarations = rootContainer?.declaration || [];

    if (!Array.isArray(declarations)) {
      declarations = [declarations];
    }

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

      // Recherche prioritaire dans la propriété participationsFinancieresDto
      let partSection = decla?.participationsFinancieresDto;
      
      // Fallback : recherche sur l'ensemble de la déclaration si non trouvé sous la clé exacte
      if (!partSection) {
        partSection = decla;
      }

      const itemsFound = findParticipationsInTree(partSection);

      for (const item of itemsFound) {
        const nomSociete = String(item.nomSociete || item.nom_societe || item.denomination || item.nomOrganisme || '').trim().toUpperCase();
        if (!nomSociete) continue;

        const montant = parseEvaluationMontant(item);

        // Déduplication (Élu + Société + Montant)
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
    console.log(`Participations financières extraites : ${records.length}`);

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
