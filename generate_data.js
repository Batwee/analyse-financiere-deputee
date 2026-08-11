const fs = require('fs');
const https = require('https');
const { XMLParser } = require('fast-xml-parser');

const XML_URL = 'https://www.hatvp.fr/livraison/merge/declarations.xml';
const OUTPUT_FILE = 'hatvp_data.json';

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

// Fonction utilitaire pour chercher récursivement des éléments dans le JS/XML
function findItemsRecursive(obj, targetKey) {
  let results = [];
  if (!obj || typeof obj !== 'object') return results;

  for (const key of Object.keys(obj)) {
    if (key === targetKey) {
      const val = obj[key];
      if (Array.isArray(val)) {
        results.push(...val);
      } else if (val) {
        results.push(val);
      }
    } else if (typeof obj[key] === 'object') {
      results.push(...findItemsRecursive(obj[key], targetKey));
    }
  }
  return results;
}

async function processData() {
  try {
    const xmlText = await downloadXML(XML_URL);
    console.log('Parsing XML...');

    const parser = new XMLParser({
      ignoreAttributes: false,
      isArray: (name) => ['declaration', 'items'].includes(name)
    });

    const parsedObj = parser.parse(xmlText);
    
    // Récupère toutes les déclarations
    const declarations = findItemsRecursive(parsedObj, 'declaration');
    console.log(`Nombre total de déclarations trouvées dans le XML: ${declarations.length}`);

    const records = [];

    for (const decla of declarations) {
      // Normalisation pour le filtre député
      const qualite = String(decla?.qualiteMandat?.typeMandat || '').toLowerCase();
      const titre = String(decla?.qualiteMandat?.qualiteDeclarantForAffichage || '').toLowerCase();

      const isDepute = qualite.includes('depute') || qualite.includes('député') || 
                       titre.includes('depute') || titre.includes('député');

      if (!isDepute) continue;

      const prenom = String(decla?.declarant?.prenom || '').trim();
      const nom = String(decla?.declarant?.nom || '').trim();
      const eluNom = `${prenom} ${nom}`.trim() || 'Inconnu';

      let parti = String(decla?.qualiteMandat?.organe?.codeOrgane || '').trim();
      if (!parti) {
        parti = String(decla?.qualiteMandat?.labelOrgane || 'Non renseigné').trim();
      }

      // Extraction de la rubrique participations financières
      const partSection = decla?.participationsFinancieresDto;
      if (!partSection) continue;

      // Recherche récursive de tous les objets ayant un "nomSociete"
      const items = findItemsRecursive(partSection, 'items');
      const allEntries = items.length > 0 ? items : (Array.isArray(partSection) ? partSection : [partSection]);

      for (const item of allEntries) {
        if (typeof item !== 'object' || !item) continue;

        const nomSociete = String(item?.nomSociete || '').trim().toUpperCase();
        const evaluationRaw = String(item?.evaluation || '0').trim();

        if (!nomSociete) continue;

        // Extraction numérique propre du montant
        const cleanVal = evaluationRaw.replace(/\s+/g, '');
        const matches = cleanVal.match(/\d+/);
        const montant = matches ? parseFloat(matches[0]) : 0;

        records.push({
          entreprise: nomSociete,
          elu: eluNom,
          parti: parti,
          montant: montant
        });
      }
    }

    console.log(`Succès ! ${records.length} participations financières de députés extraites.`);

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(records, null, 2), 'utf-8');
    console.log(`Fichier ${OUTPUT_FILE} mis à jour.`);

  } catch (error) {
    console.error('Erreur lors du traitement :', error);
    process.exit(1);
  }
}

processData();
